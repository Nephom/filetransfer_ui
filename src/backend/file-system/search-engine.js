/**
 * Intelligent Search Engine for File System
 * Supports search-driven caching strategies, progressive results, and smart path prioritization
 */

const { EventEmitter } = require('events');
const path = require('path');
const { createClient } = require('redis');
const config = require('../config/config');
const { CACHE_LAYERS, CACHE_PRIORITY } = require('./layered-cache');

// Search result context types
const SEARCH_CONTEXT = {
  EXACT_MATCH: 'exact',
  PARTIAL_MATCH: 'partial',
  FUZZY_MATCH: 'fuzzy',
  CONTENT_MATCH: 'content'
};

// Search priority levels
const SEARCH_PRIORITY = {
  CRITICAL: 4,    // Exact filename matches
  HIGH: 3,        // Partial matches in frequently accessed dirs
  MEDIUM: 2,      // Fuzzy matches
  LOW: 1          // Deep directory matches
};

// Search modes
const SEARCH_MODE = {
  INSTANT: 'instant',        // Return cached results immediately
  PROGRESSIVE: 'progressive', // Return results as they're found
  COMPREHENSIVE: 'comprehensive' // Complete search across all layers
};

class IntelligentSearchEngine extends EventEmitter {
  constructor(layeredCache) {
    super();
    this.layeredCache = layeredCache;
    this.redisClient = null;
    
    // Search analytics and history
    this.searchHistory = new Map(); // query -> { count, lastSearch, avgResponseTime, patterns }
    this.searchPatterns = new Map(); // pattern -> frequency
    this.pathPriorities = new Map(); // path -> { accessCount, searchCount, priority }
    this.searchSessions = new Map(); // sessionId -> { queries, startTime, results }
    
    // Progressive search state
    this.activeSearches = new Map(); // searchId -> { query, options, results, progress }
    this.searchContextCache = new Map(); // query -> { results, timestamp, context }
    
    // Configuration
    this.maxCacheSize = 10000; // Max cached search results
    this.contextCacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.progressiveChunkSize = 100; // Results per progressive chunk
  }

  /**
   * Initialize the search engine
   */
  async initialize() {
    console.log('Initializing intelligent search engine...');

    // Connect to Redis for search analytics
    try {
      const redisUrl = config.get('redisUrl');
      this.redisClient = createClient({ url: redisUrl });
      this.redisClient.on('error', (err) => console.error('Search Engine Redis Error', err));
      await this.redisClient.connect();
      
      // Load existing search history and patterns
      await this.loadSearchAnalytics();
      
      console.log('Search engine Redis connection established');
    } catch (error) {
      console.warn('Search engine Redis connection failed, running in local mode:', error.message);
      // Continue without Redis - use local maps
    }

    // Start periodic cache cleanup
    this.startCacheCleanup();

    console.log('Intelligent search engine initialized');
  }

  /**
   * Load search analytics from Redis
   */
  async loadSearchAnalytics() {
    if (!this.redisClient) return;

    try {
      // Load search history
      const historyKeys = await this.redisClient.keys('search:history:*');
      for (const key of historyKeys) {
        const query = key.substring('search:history:'.length);
        const data = await this.redisClient.hGetAll(key);
        if (data) {
          this.searchHistory.set(query, {
            count: parseInt(data.count) || 0,
            lastSearch: data.lastSearch || Date.now(),
            avgResponseTime: parseFloat(data.avgResponseTime) || 0,
            patterns: JSON.parse(data.patterns || '[]')
          });
        }
      }

      // Load search patterns
      const patternKeys = await this.redisClient.keys('search:pattern:*');
      for (const key of patternKeys) {
        const pattern = key.substring('search:pattern:'.length);
        const frequency = await this.redisClient.get(key);
        if (frequency) {
          this.searchPatterns.set(pattern, parseInt(frequency));
        }
      }

      // Load path priorities
      const priorityKeys = await this.redisClient.keys('search:priority:*');
      for (const key of priorityKeys) {
        const filePath = key.substring('search:priority:'.length);
        const data = await this.redisClient.hGetAll(key);
        if (data) {
          this.pathPriorities.set(filePath, {
            accessCount: parseInt(data.accessCount) || 0,
            searchCount: parseInt(data.searchCount) || 0,
            priority: parseInt(data.priority) || SEARCH_PRIORITY.MEDIUM
          });
        }
      }

      console.log(`Loaded ${this.searchHistory.size} search queries, ${this.searchPatterns.size} patterns, ${this.pathPriorities.size} path priorities`);
    } catch (error) {
      console.error('Error loading search analytics:', error);
    }
  }

  /**
   * Save search analytics to Redis
   */
  async saveSearchAnalytics() {
    if (!this.redisClient) return;

    try {
      // Save search history
      for (const [query, data] of this.searchHistory) {
        await this.redisClient.hSet(`search:history:${query}`, {
          count: data.count,
          lastSearch: data.lastSearch,
          avgResponseTime: data.avgResponseTime,
          patterns: JSON.stringify(data.patterns)
        });
      }

      // Save search patterns
      for (const [pattern, frequency] of this.searchPatterns) {
        await this.redisClient.set(`search:pattern:${pattern}`, frequency);
      }

      // Save path priorities
      for (const [filePath, data] of this.pathPriorities) {
        await this.redisClient.hSet(`search:priority:${filePath}`, {
          accessCount: data.accessCount,
          searchCount: data.searchCount,
          priority: data.priority
        });
      }
    } catch (error) {
      console.error('Error saving search analytics:', error);
    }
  }

  /**
   * Execute intelligent search with multiple strategies
   */
  async search(query, options = {}) {
    const {
      mode = SEARCH_MODE.PROGRESSIVE,
      limit = 1000,
      sessionId = null,
      includeContent = false,
      fuzzyThreshold = 0.7,
      contextualSearch = true
    } = options;

    const searchId = this.generateSearchId();
    const startTime = Date.now();

    // Record search session
    if (sessionId) {
      this.trackSearchSession(sessionId, query);
    }

    // Analyze and record search query
    this.analyzeSearchQuery(query);

    try {
      let results = [];

      switch (mode) {
        case SEARCH_MODE.INSTANT:
          results = await this.instantSearch(query, options);
          break;
        case SEARCH_MODE.PROGRESSIVE:
          results = await this.progressiveSearch(searchId, query, options);
          break;
        case SEARCH_MODE.COMPREHENSIVE:
          results = await this.comprehensiveSearch(query, options);
          break;
      }

      // Update search analytics
      const responseTime = Date.now() - startTime;
      this.updateSearchHistory(query, responseTime);

      // Cache results for contextual reuse
      if (contextualSearch) {
        this.cacheSearchResults(query, results);
      }

      // Update path priorities based on results
      this.updatePathPriorities(results, query);

      return {
        searchId,
        query,
        results,
        mode,
        responseTime,
        totalResults: results.length,
        context: this.getSearchContext(query, results)
      };

    } catch (error) {
      console.error('Search error:', error);
      throw error;
    }
  }

  /**
   * Instant search - return cached or fast metadata results
   */
  async instantSearch(query, options = {}) {
    const { limit = 100 } = options;

    // Check context cache first
    const cached = this.searchContextCache.get(query);
    if (cached && Date.now() - cached.timestamp < this.contextCacheTimeout) {
      console.log(`Returning cached results for: ${query}`);
      return cached.results.slice(0, limit);
    }

    // Fast search using metadata layer
    const results = await this.layeredCache.searchFiles(query, {
      layer: CACHE_LAYERS.METADATA,
      limit: limit,
      priorityFilter: CACHE_PRIORITY.HIGH
    });

    // Enhance with smart prioritization
    return this.prioritizeSearchResults(results, query);
  }

  /**
   * Progressive search - return results as they're found
   */
  async progressiveSearch(searchId, query, options = {}) {
    const { limit = 1000, onProgress = null } = options;
    
    this.activeSearches.set(searchId, {
      query,
      options,
      results: [],
      progress: { current: 0, total: 0, phase: 'starting' }
    });

    const results = [];
    
    try {
      // Phase 1: Fast metadata search
      this.updateSearchProgress(searchId, { phase: 'metadata', current: 0, total: 100 });
      const metadataResults = await this.layeredCache.searchFiles(query, {
        layer: CACHE_LAYERS.METADATA,
        limit: Math.min(limit, 200)
      });
      
      results.push(...this.prioritizeSearchResults(metadataResults, query));
      this.updateSearchProgress(searchId, { phase: 'metadata', current: 100, total: 100 });
      
      if (onProgress) {
        onProgress({
          searchId,
          results: results.slice(0, this.progressiveChunkSize),
          phase: 'metadata',
          isComplete: false
        });
      }

      // Phase 2: Content layer search (if not enough results)
      if (results.length < limit / 2) {
        this.updateSearchProgress(searchId, { phase: 'content', current: 0, total: 100 });
        
        const contentResults = await this.layeredCache.searchFiles(query, {
          layer: CACHE_LAYERS.CONTENT,
          limit: limit - results.length
        });
        
        const newResults = this.prioritizeSearchResults(contentResults, query)
          .filter(r => !results.some(existing => existing.path === r.path));
        
        results.push(...newResults);
        this.updateSearchProgress(searchId, { phase: 'content', current: 100, total: 100 });
        
        if (onProgress) {
          onProgress({
            searchId,
            results: results.slice(0, this.progressiveChunkSize * 2),
            phase: 'content',
            isComplete: false
          });
        }
      }

      // Phase 3: Full directory search (if still not enough)
      if (results.length < limit * 0.8) {
        this.updateSearchProgress(searchId, { phase: 'directory', current: 0, total: 100 });
        
        const directoryResults = await this.layeredCache.searchFiles(query, {
          layer: CACHE_LAYERS.DIRECTORY,
          limit: limit - results.length
        });
        
        const newResults = this.prioritizeSearchResults(directoryResults, query)
          .filter(r => !results.some(existing => existing.path === r.path));
        
        results.push(...newResults);
        this.updateSearchProgress(searchId, { phase: 'directory', current: 100, total: 100 });
      }

      // Final results
      this.updateSearchProgress(searchId, { phase: 'complete', current: 100, total: 100 });
      
      if (onProgress) {
        onProgress({
          searchId,
          results: results.slice(0, limit),
          phase: 'complete',
          isComplete: true
        });
      }

      return results.slice(0, limit);

    } finally {
      this.activeSearches.delete(searchId);
    }
  }

  /**
   * Comprehensive search - search all layers thoroughly
   */
  async comprehensiveSearch(query, options = {}) {
    const { limit = 1000, includeContent = false } = options;
    const allResults = new Map(); // Use Map to deduplicate by path

    // Search all layers
    const layers = [CACHE_LAYERS.METADATA, CACHE_LAYERS.CONTENT, CACHE_LAYERS.DIRECTORY];
    
    for (const layer of layers) {
      const layerResults = await this.layeredCache.searchFiles(query, {
        layer,
        limit: limit * 2 // Get more results to ensure we have good coverage
      });

      // Add to results map (deduplicates automatically)
      for (const result of layerResults) {
        if (!allResults.has(result.path)) {
          allResults.set(result.path, { ...result, searchLayers: [layer] });
        } else {
          // Merge layer information
          const existing = allResults.get(result.path);
          existing.searchLayers.push(layer);
          // Use more detailed info from content/directory layers
          if (layer !== CACHE_LAYERS.METADATA && result.size !== undefined) {
            allResults.set(result.path, { ...existing, ...result, searchLayers: existing.searchLayers });
          }
        }
      }
    }

    // Convert back to array and prioritize
    const results = Array.from(allResults.values());
    const prioritizedResults = this.prioritizeSearchResults(results, query);

    return prioritizedResults.slice(0, limit);
  }

  /**
   * Prioritize search results based on multiple factors
   */
  prioritizeSearchResults(results, query) {
    const queryLower = query.toLowerCase();
    
    return results.map(result => {
      let score = 0;
      const nameLower = result.name.toLowerCase();
      
      // Exact name match gets highest score
      if (nameLower === queryLower) {
        score += 1000;
        result.matchType = SEARCH_CONTEXT.EXACT_MATCH;
      }
      // Name starts with query
      else if (nameLower.startsWith(queryLower)) {
        score += 800;
        result.matchType = SEARCH_CONTEXT.PARTIAL_MATCH;
      }
      // Name contains query
      else if (nameLower.includes(queryLower)) {
        score += 600;
        result.matchType = SEARCH_CONTEXT.PARTIAL_MATCH;
      }
      // Fuzzy match
      else {
        const similarity = this.calculateStringSimilarity(nameLower, queryLower);
        if (similarity > 0.6) {
          score += similarity * 400;
          result.matchType = SEARCH_CONTEXT.FUZZY_MATCH;
        } else {
          score += 200;
          result.matchType = SEARCH_CONTEXT.CONTENT_MATCH;
        }
      }
      
      // Boost based on file type
      if (result.isDirectory) score += 100;
      
      // Boost based on cache layer priority
      score += (result.priority || CACHE_PRIORITY.MEDIUM) * 50;
      
      // Boost based on path access history
      const pathPriority = this.pathPriorities.get(result.path);
      if (pathPriority) {
        score += pathPriority.accessCount * 10;
        score += pathPriority.searchCount * 20;
      }
      
      // Boost recent files
      if (result.modified) {
        const daysSinceModified = (Date.now() - new Date(result.modified)) / (1000 * 60 * 60 * 24);
        if (daysSinceModified < 7) score += 50;
        if (daysSinceModified < 1) score += 100;
      }
      
      // Penalize deep paths
      const pathDepth = result.path.split('/').length;
      if (pathDepth > 5) score -= (pathDepth - 5) * 10;
      
      result.searchScore = score;
      return result;
    }).sort((a, b) => b.searchScore - a.searchScore);
  }

  /**
   * Calculate string similarity for fuzzy matching
   */
  calculateStringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance for string similarity
   */
  levenshteinDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i += 1) {
      matrix[0][i] = i;
    }
    
    for (let j = 0; j <= str2.length; j += 1) {
      matrix[j][0] = j;
    }
    
    for (let j = 1; j <= str2.length; j += 1) {
      for (let i = 1; i <= str1.length; i += 1) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Analyze search query for patterns and insights
   */
  analyzeSearchQuery(query) {
    // Record query patterns
    const patterns = this.extractSearchPatterns(query);
    for (const pattern of patterns) {
      const current = this.searchPatterns.get(pattern) || 0;
      this.searchPatterns.set(pattern, current + 1);
    }

    // Update search history
    const current = this.searchHistory.get(query) || {
      count: 0,
      lastSearch: 0,
      avgResponseTime: 0,
      patterns: []
    };
    
    current.count += 1;
    current.lastSearch = Date.now();
    current.patterns = [...new Set([...current.patterns, ...patterns])];
    
    this.searchHistory.set(query, current);
  }

  /**
   * Extract search patterns from query
   */
  extractSearchPatterns(query) {
    const patterns = [];
    
    // File extension pattern
    const extMatch = query.match(/\.([a-zA-Z0-9]+)$/);
    if (extMatch) {
      patterns.push(`ext:${extMatch[1]}`);
    }
    
    // Path separator pattern
    if (query.includes('/') || query.includes('\\')) {
      patterns.push('path:contains_separator');
    }
    
    // Numeric pattern
    if (/\d+/.test(query)) {
      patterns.push('contains:numbers');
    }
    
    // Special characters
    if (/[_-]/.test(query)) {
      patterns.push('contains:separators');
    }
    
    // Length-based patterns
    if (query.length <= 3) {
      patterns.push('length:short');
    } else if (query.length > 20) {
      patterns.push('length:long');
    }
    
    // Word count
    const words = query.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
      patterns.push('multi:word');
    }
    
    return patterns;
  }

  /**
   * Update search history with response time
   */
  updateSearchHistory(query, responseTime) {
    const history = this.searchHistory.get(query);
    if (history) {
      // Calculate rolling average response time
      history.avgResponseTime = (history.avgResponseTime * (history.count - 1) + responseTime) / history.count;
      this.searchHistory.set(query, history);
    }
  }

  /**
   * Update path priorities based on search results
   */
  updatePathPriorities(results, query) {
    for (const result of results) {
      const current = this.pathPriorities.get(result.path) || {
        accessCount: 0,
        searchCount: 0,
        priority: SEARCH_PRIORITY.MEDIUM
      };
      
      current.searchCount += 1;
      
      // Boost priority for frequently found files
      if (current.searchCount > 5) {
        current.priority = Math.min(current.priority + 1, SEARCH_PRIORITY.CRITICAL);
      }
      
      this.pathPriorities.set(result.path, current);
    }
  }

  /**
   * Track search session for analytics
   */
  trackSearchSession(sessionId, query) {
    if (!this.searchSessions.has(sessionId)) {
      this.searchSessions.set(sessionId, {
        queries: [],
        startTime: Date.now(),
        results: []
      });
    }
    
    const session = this.searchSessions.get(sessionId);
    session.queries.push({
      query,
      timestamp: Date.now()
    });
  }

  /**
   * Cache search results for contextual reuse
   */
  cacheSearchResults(query, results) {
    // Implement LRU cache
    if (this.searchContextCache.size >= this.maxCacheSize) {
      // Remove oldest entries
      const entries = Array.from(this.searchContextCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      // Remove oldest 10%
      const toRemove = Math.floor(this.maxCacheSize * 0.1);
      for (let i = 0; i < toRemove; i++) {
        this.searchContextCache.delete(entries[i][0]);
      }
    }
    
    this.searchContextCache.set(query, {
      results: results.slice(0, 100), // Cache top 100 results
      timestamp: Date.now(),
      context: this.getSearchContext(query, results)
    });
  }

  /**
   * Get search context for results
   */
  getSearchContext(query, results) {
    const context = {
      exactMatches: results.filter(r => r.matchType === SEARCH_CONTEXT.EXACT_MATCH).length,
      partialMatches: results.filter(r => r.matchType === SEARCH_CONTEXT.PARTIAL_MATCH).length,
      fuzzyMatches: results.filter(r => r.matchType === SEARCH_CONTEXT.FUZZY_MATCH).length,
      directories: results.filter(r => r.isDirectory).length,
      files: results.filter(r => !r.isDirectory).length,
      avgScore: results.reduce((sum, r) => sum + (r.searchScore || 0), 0) / results.length || 0
    };
    
    // Suggest related searches based on patterns
    const patterns = this.extractSearchPatterns(query);
    context.suggestedQueries = this.getSuggestedQueries(query, patterns);
    
    return context;
  }

  /**
   * Get suggested queries based on search patterns
   */
  getSuggestedQueries(query, patterns) {
    const suggestions = [];
    
    // Based on common patterns
    for (const [pattern, frequency] of this.searchPatterns) {
      if (frequency > 5 && !patterns.includes(pattern)) {
        if (pattern.startsWith('ext:')) {
          suggestions.push(`${query}.${pattern.substring(4)}`);
        }
      }
    }
    
    // Based on similar queries in history
    for (const [histQuery, data] of this.searchHistory) {
      if (data.count > 3 && histQuery !== query) {
        const similarity = this.calculateStringSimilarity(query.toLowerCase(), histQuery.toLowerCase());
        if (similarity > 0.7) {
          suggestions.push(histQuery);
        }
      }
    }
    
    return suggestions.slice(0, 5); // Return top 5 suggestions
  }

  /**
   * Update search progress for progressive searches
   */
  updateSearchProgress(searchId, progress) {
    const search = this.activeSearches.get(searchId);
    if (search) {
      search.progress = { ...search.progress, ...progress };
      this.emit('searchProgress', { searchId, progress: search.progress });
    }
  }

  /**
   * Get search progress for active searches
   */
  getSearchProgress(searchId) {
    const search = this.activeSearches.get(searchId);
    return search ? search.progress : null;
  }

  /**
   * Generate unique search ID
   */
  generateSearchId() {
    return `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get search analytics and insights
   */
  getSearchAnalytics() {
    const topQueries = Array.from(this.searchHistory.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([query, data]) => ({ query, ...data }));
    
    const topPatterns = Array.from(this.searchPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pattern, frequency]) => ({ pattern, frequency }));
    
    const activeSessions = Array.from(this.searchSessions.entries())
      .filter(([id, session]) => Date.now() - session.startTime < 30 * 60 * 1000) // Active in last 30min
      .length;
    
    return {
      totalQueries: this.searchHistory.size,
      totalPatterns: this.searchPatterns.size,
      cachedResults: this.searchContextCache.size,
      activeSearches: this.activeSearches.size,
      activeSessions,
      topQueries,
      topPatterns,
      pathPriorities: this.pathPriorities.size
    };
  }

  /**
   * Pre-cache directories based on search patterns
   */
  async smartPreCache() {
    console.log('Starting smart pre-caching based on search patterns...');
    
    // Analyze search patterns to predict likely search targets
    const frequentPatterns = Array.from(this.searchPatterns.entries())
      .filter(([pattern, frequency]) => frequency > 5)
      .sort((a, b) => b[1] - a[1]);
    
    const directoriesToPreCache = new Set();
    
    // Add frequently accessed paths
    for (const [filePath, data] of this.pathPriorities) {
      if (data.searchCount > 10 || data.priority >= SEARCH_PRIORITY.HIGH) {
        const dirPath = path.dirname(filePath);
        if (dirPath && dirPath !== '.') {
          directoriesToPreCache.add(dirPath);
        }
      }
    }
    
    // Convert to array and limit
    const pathsArray = Array.from(directoriesToPreCache).slice(0, 20);
    
    if (pathsArray.length > 0) {
      console.log(`Pre-caching ${pathsArray.length} directories based on search analytics`);
      
      for (const dirPath of pathsArray) {
        try {
          await this.layeredCache.refreshPath(dirPath);
        } catch (error) {
          console.warn(`Failed to pre-cache directory ${dirPath}:`, error.message);
        }
      }
      
      console.log('Smart pre-caching completed');
    } else {
      console.log('No directories identified for pre-caching');
    }
  }

  /**
   * Start periodic cache cleanup and analytics saving
   */
  startCacheCleanup() {
    setInterval(() => {
      // Clean up old search context cache
      const cutoff = Date.now() - this.contextCacheTimeout;
      for (const [query, data] of this.searchContextCache) {
        if (data.timestamp < cutoff) {
          this.searchContextCache.delete(query);
        }
      }
      
      // Clean up old search sessions
      const sessionCutoff = Date.now() - (2 * 60 * 60 * 1000); // 2 hours
      for (const [sessionId, session] of this.searchSessions) {
        if (session.startTime < sessionCutoff) {
          this.searchSessions.delete(sessionId);
        }
      }
      
      // Save analytics to Redis
      this.saveSearchAnalytics().catch(console.error);
      
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Close search engine and cleanup
   */
  async close() {
    console.log('Closing intelligent search engine...');
    
    // Save final analytics
    await this.saveSearchAnalytics();
    
    // Close Redis connection
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
    
    // Clear all caches
    this.searchHistory.clear();
    this.searchPatterns.clear();
    this.pathPriorities.clear();
    this.searchSessions.clear();
    this.activeSearches.clear();
    this.searchContextCache.clear();
    
    console.log('Search engine closed');
  }
}

module.exports = {
  IntelligentSearchEngine,
  SEARCH_CONTEXT,
  SEARCH_PRIORITY,
  SEARCH_MODE
};