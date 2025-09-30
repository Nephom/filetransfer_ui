// Configuration management for file transfer application
const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../../config.ini');
    this.defaultConfig = {
      port: 3000,
      storagePath: './storage',
      username: 'admin',
      redisUrl: 'redis://localhost:6379'
    };
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        // Simple INI parsing - in a real app you'd want a proper parser
        const config = {};
        configData.split('\n').forEach(line => {
          if (line.includes('=')) {
            const [key, value] = line.split('=');
            config[key.trim()] = value.trim();
          }
        });
        return { ...this.defaultConfig, ...config };
      }
      return this.defaultConfig;
    } catch (error) {
      console.error('Error loading config:', error);
      return this.defaultConfig;
    }
  }

  saveConfig(config) {
    try {
      const configStr = Object.entries(config)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      fs.writeFileSync(this.configPath, configStr);
      this.config = config;
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.saveConfig(this.config);
  }

  getAll() {
    return this.config;
  }
}

module.exports = new ConfigManager();