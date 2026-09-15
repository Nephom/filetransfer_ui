// Global Styles Component
const GlobalStyles = () => {
    return (
        <style>
            {`
                @keyframes pulse {
                    0%, 100% { opacity: 0.3; transform: scale(1); }
                    50% { opacity: 0.5; transform: scale(1.05); }
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                ::placeholder {
                    color: rgba(255, 255, 255, 0.6);
                }
                
                /* Custom scrollbar for webkit browsers */
                ::-webkit-scrollbar {
                    width: 8px;
                }
                ::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                }
                ::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.3);
                    border-radius: 4px;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.5);
                }
                
                /* Focus styles */
                button:focus-visible,
                input:focus-visible {
                    outline: 2px solid rgba(59, 130, 246, 0.8);
                    outline-offset: 2px;
                }

                .ai-analysis-progress {
                    position: relative;
                    display: grid;
                    grid-template-columns: 132px minmax(0, 1fr) auto;
                    align-items: center;
                    gap: 24px;
                    min-height: 218px;
                    padding: 28px;
                    overflow: hidden;
                    isolation: isolate;
                    border: 1px solid rgba(103, 207, 255, 0.28);
                    border-radius: 20px;
                    background:
                        radial-gradient(circle at 14% 50%, rgba(48, 201, 255, 0.18), transparent 28%),
                        linear-gradient(135deg, rgba(6, 31, 54, 0.96), rgba(8, 17, 37, 0.98));
                    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 18px 45px rgba(0, 0, 0, 0.28);
                }
                .ai-analysis-progress::before {
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    background: repeating-linear-gradient(0deg, transparent 0 7px, rgba(103, 207, 255, 0.035) 8px, transparent 9px);
                    content: '';
                    pointer-events: none;
                }
                .ai-analysis-visual {
                    position: relative;
                    width: 116px;
                    height: 116px;
                    margin: auto;
                    border: 1px solid rgba(103, 207, 255, 0.18);
                    border-radius: 50%;
                    background: radial-gradient(circle, rgba(31, 161, 220, 0.2), rgba(2, 19, 39, 0.1) 55%, transparent 56%);
                    box-shadow: 0 0 36px rgba(48, 201, 255, 0.16);
                }
                .ai-analysis-ring,
                .ai-analysis-core,
                .ai-analysis-node {
                    position: absolute;
                    display: block;
                }
                .ai-analysis-ring {
                    inset: 9px;
                    border: 1px solid rgba(141, 233, 255, 0.62);
                    border-right-color: transparent;
                    border-radius: 50%;
                    animation: ai-analysis-spin 4s linear infinite;
                }
                .ai-analysis-ring-inner {
                    inset: 24px;
                    border-color: rgba(151, 126, 255, 0.78);
                    border-left-color: transparent;
                    animation-direction: reverse;
                    animation-duration: 2.6s;
                }
                .ai-analysis-core {
                    inset: 39px;
                    border: 1px solid rgba(166, 243, 255, 0.72);
                    border-radius: 50%;
                    background: rgba(55, 198, 255, 0.18);
                    box-shadow: 0 0 24px rgba(76, 216, 255, 0.8), inset 0 0 14px rgba(255, 255, 255, 0.28);
                    animation: ai-analysis-breathe 2.2s ease-in-out infinite;
                }
                .ai-analysis-core span {
                    position: absolute;
                    inset: 11px;
                    border-radius: 50%;
                    background: #c8f7ff;
                    box-shadow: 0 0 16px #6de5ff;
                }
                .ai-analysis-node {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #9cecff;
                    box-shadow: 0 0 12px #55d8ff;
                    animation: ai-analysis-node-pulse 1.8s ease-in-out infinite;
                }
                .ai-analysis-node-one { top: 5px; left: 55px; }
                .ai-analysis-node-two { right: 8px; bottom: 28px; animation-delay: 0.55s; }
                .ai-analysis-node-three { bottom: 10px; left: 23px; animation-delay: 1.05s; }
                .ai-analysis-copy { min-width: 0; }
                .ai-analysis-eyebrow {
                    display: flex;
                    align-items: center;
                    gap: 7px;
                    color: #8fe8ff;
                    font-size: 10px;
                    font-weight: 800;
                    letter-spacing: 0.16em;
                }
                .ai-analysis-eyebrow > span:not(.ai-analysis-live-dot) { color: rgba(255, 255, 255, 0.34); }
                .ai-analysis-live-dot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: #6cf1c4;
                    box-shadow: 0 0 0 4px rgba(108, 241, 196, 0.1), 0 0 12px #6cf1c4;
                    animation: ai-analysis-live 1.5s ease-in-out infinite;
                }
                .ai-analysis-copy h3 {
                    margin: 10px 0 7px;
                    color: #f2fbff;
                    font-size: clamp(20px, 2.4vw, 27px);
                    line-height: 1.12;
                    letter-spacing: -0.02em;
                }
                .ai-analysis-phase,
                .ai-analysis-source,
                .ai-analysis-hint { margin: 0; }
                .ai-analysis-phase {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: #b9d9e6;
                    font-size: 13px;
                }
                .ai-analysis-phase-marker {
                    width: 6px;
                    height: 6px;
                    flex: 0 0 auto;
                    border-radius: 50%;
                    background: #8c7bff;
                    box-shadow: 0 0 10px #8c7bff;
                }
                .ai-analysis-source {
                    max-width: 100%;
                    margin-top: 8px;
                    overflow: hidden;
                    color: rgba(231, 247, 255, 0.58);
                    font-size: 12px;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .ai-analysis-source strong { color: rgba(231, 247, 255, 0.86); font-weight: 600; }
                .ai-analysis-scanline {
                    position: relative;
                    height: 3px;
                    margin: 18px 0 11px;
                    overflow: hidden;
                    border-radius: 99px;
                    background: rgba(116, 203, 238, 0.12);
                }
                .ai-analysis-scanline span {
                    position: absolute;
                    top: 0;
                    left: -35%;
                    width: 35%;
                    height: 100%;
                    border-radius: inherit;
                    background: linear-gradient(90deg, transparent, #83edff, transparent);
                    animation: ai-analysis-scan 1.8s ease-in-out infinite;
                }
                .ai-analysis-hint { color: rgba(231, 247, 255, 0.48); font-size: 11px; line-height: 1.45; }
                .ai-analysis-cancel {
                    align-self: end;
                    min-width: 132px;
                    padding: 10px 13px;
                    border: 1px solid rgba(157, 219, 238, 0.25);
                    border-radius: 10px;
                    color: rgba(232, 249, 255, 0.74);
                    background: rgba(255, 255, 255, 0.04);
                    font-size: 12px;
                    font-weight: 700;
                    cursor: pointer;
                }
                .ai-analysis-cancel:hover { border-color: rgba(157, 219, 238, 0.58); color: #fff; background: rgba(103, 207, 255, 0.12); }
                @keyframes ai-analysis-spin { to { transform: rotate(360deg); } }
                @keyframes ai-analysis-breathe { 0%, 100% { transform: scale(0.92); opacity: 0.72; } 50% { transform: scale(1.08); opacity: 1; } }
                @keyframes ai-analysis-node-pulse { 0%, 100% { transform: scale(0.65); opacity: 0.35; } 50% { transform: scale(1.35); opacity: 1; } }
                @keyframes ai-analysis-live { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
                @keyframes ai-analysis-scan { from { transform: translateX(0); } to { transform: translateX(385%); } }
                @media (max-width: 600px) {
                    .ai-analysis-progress { grid-template-columns: 76px minmax(0, 1fr); gap: 16px; min-height: 0; padding: 20px; }
                    .ai-analysis-visual { width: 70px; height: 70px; }
                    .ai-analysis-ring { inset: 6px; }
                    .ai-analysis-ring-inner { inset: 15px; }
                    .ai-analysis-core { inset: 24px; }
                    .ai-analysis-core span { inset: 6px; }
                    .ai-analysis-node-one { top: 2px; left: 32px; }
                    .ai-analysis-node-two { right: 2px; bottom: 17px; }
                    .ai-analysis-node-three { bottom: 4px; left: 14px; }
                    .ai-analysis-cancel { grid-column: 2; justify-self: start; align-self: auto; }
                }
                @media (prefers-reduced-motion: reduce) {
                    .ai-analysis-ring, .ai-analysis-core, .ai-analysis-node, .ai-analysis-live-dot, .ai-analysis-scanline span { animation: none; }
                    .ai-analysis-core, .ai-analysis-live-dot { opacity: 0.85; }
                    .ai-analysis-scanline span { left: 0; width: 100%; opacity: 0.5; }
                }

                .share-links-dialog { display: grid; gap: 14px; max-height: 62vh; overflow: auto; }
                .share-links-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
                .share-links-toolbar p { margin: 0; color: rgba(255, 255, 255, 0.75); }
                .share-link-groups { display: grid; gap: 18px; }
                .share-link-group { display: grid; gap: 10px; }
                .share-link-group-heading { display: flex; align-items: center; gap: 10px; padding-bottom: 6px; border-bottom: 1px solid rgba(103, 207, 255, 0.2); }
                .share-link-group-heading h3 { margin: 0; color: rgba(255, 255, 255, 0.9); font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; }
                .share-link-group-heading > span { min-width: 22px; padding: 2px 7px; border: 1px solid rgba(103, 207, 255, 0.3); border-radius: 999px; color: #9eeaff; font-size: 11px; text-align: center; }
                .share-link-group-heading button { margin-left: auto; }
                .share-links-list { display: grid; gap: 12px; }
                .share-link-card { display: grid; gap: 7px; padding: 14px; border: 1px solid rgba(103, 207, 255, 0.3); border-radius: 12px; background: rgba(4, 22, 42, 0.62); box-shadow: inset 0 0 24px rgba(45, 177, 255, 0.05), 0 10px 25px rgba(0, 0, 0, 0.18); }
                .share-link-card-heading { display: flex; align-items: flex-start; flex-direction: column; gap: 6px; }
                .share-link-card-heading strong { min-width: 0; overflow-wrap: anywhere; }
                .share-link-card small { color: rgba(255, 255, 255, 0.62); overflow-wrap: anywhere; }
                .share-link-card label { margin: 4px 0 0; color: rgba(255, 255, 255, 0.78); }
                .share-link-card input { min-width: 0; color: #e8f7ff; background: rgba(0, 10, 24, 0.58); }
                .share-link-status { flex: 0 0 auto; padding: 3px 8px; border: 1px solid rgba(103, 207, 255, 0.3); border-radius: 999px; color: #9eeaff; font-size: 11px; white-space: nowrap; }
                .share-link-status.expired, .share-link-status.exhausted, .share-link-status.revoked { color: #ffb7af; border-color: rgba(255, 111, 111, 0.45); }
                @media (max-width: 600px) { .share-links-toolbar, .share-link-card-heading { align-items: flex-start; flex-direction: column; } .share-link-group-heading { flex-wrap: wrap; } .share-link-group-heading button { margin-left: 0; } }
                
                /* Selection styles */
                ::selection {
                    background: rgba(59, 130, 246, 0.3);
                    color: white;
                }
                
                /* Smooth transitions for all interactive elements */
                button, input, select, textarea {
                    transition: all 0.3s ease;
                }
                
                /* Glass effect utilities */
                .glass {
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                }
                
                .glass-strong {
                    background: rgba(255, 255, 255, 0.15);
                    backdrop-filter: blur(25px);
                    border: 1px solid rgba(255, 255, 255, 0.3);
                }
                
                /* Hover effects */
                .hover-lift {
                    transition: transform 0.3s ease, box-shadow 0.3s ease;
                }
                
                .hover-lift:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.2);
                }
                
                /* Button styles */
                .btn-primary {
                    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                    border: none;
                    color: white;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s ease;
                }
                
                .btn-primary:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }
                
                .btn-secondary {
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    color: white;
                    cursor: pointer;
                    backdrop-filter: blur(10px);
                    transition: all 0.3s ease;
                }
                
                .btn-secondary:hover {
                    background: rgba(255, 255, 255, 0.2);
                }
                
                /* Loading spinner */
                .spinner {
                    width: 20px;
                    height: 20px;
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    border-top: 2px solid white;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                
                /* Text utilities */
                .text-gradient {
                    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                
                /* Card styles */
                .card {
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                }
                
                .card-header {
                    padding: 24px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                }
                
                .card-body {
                    padding: 24px;
                }
                
                .card-footer {
                    padding: 24px;
                    border-top: 1px solid rgba(255, 255, 255, 0.2);
                }
                
                /* Modal styles */
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    backdrop-filter: blur(5px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                }
                
                /* Form styles */
                .form-group {
                    margin-bottom: 24px;
                }
                
                .form-label {
                    display: block;
                    color: rgba(255, 255, 255, 0.9);
                    margin-bottom: 8px;
                    font-size: 14px;
                    font-weight: 500;
                }
                
                .form-input {
                    width: 100%;
                    padding: 16px;
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 12px;
                    color: white;
                    font-size: 16px;
                    box-sizing: border-box;
                    backdrop-filter: blur(10px);
                    transition: all 0.3s ease;
                    outline: none;
                }
                
                .form-input:focus {
                    border-color: rgba(59, 130, 246, 0.8);
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
                }
                
                /* Status message styles */
                .status-success {
                    background: rgba(34, 197, 94, 0.2);
                    border: 1px solid rgba(34, 197, 94, 0.5);
                    color: white;
                    padding: 12px 16px;
                    border-radius: 12px;
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .status-error {
                    background: rgba(239, 68, 68, 0.2);
                    border: 1px solid rgba(239, 68, 68, 0.5);
                    color: white;
                    padding: 12px 16px;
                    border-radius: 12px;
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                /* Grid layouts */
                .grid-auto-fit {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 16px;
                }
                
                /* Flex utilities */
                .flex {
                    display: flex;
                }
                
                .flex-col {
                    flex-direction: column;
                }
                
                .items-center {
                    align-items: center;
                }
                
                .justify-center {
                    justify-content: center;
                }
                
                .justify-between {
                    justify-content: space-between;
                }
                
                .gap-2 { gap: 8px; }
                .gap-3 { gap: 12px; }
                .gap-4 { gap: 16px; }
                .gap-6 { gap: 24px; }
                
                /* Spacing utilities */
                .p-4 { padding: 16px; }
                .p-6 { padding: 24px; }
                .px-4 { padding-left: 16px; padding-right: 16px; }
                .py-3 { padding-top: 12px; padding-bottom: 12px; }
                .mb-4 { margin-bottom: 16px; }
                .mb-6 { margin-bottom: 24px; }
                
                /* Text utilities */
                .text-white { color: white; }
                .text-sm { font-size: 14px; }
                .text-lg { font-size: 18px; }
                .text-xl { font-size: 20px; }
                .text-2xl { font-size: 24px; }
                .font-bold { font-weight: bold; }
                .font-semibold { font-weight: 600; }
                
                /* Border radius utilities */
                .rounded { border-radius: 8px; }
                .rounded-lg { border-radius: 12px; }
                .rounded-xl { border-radius: 16px; }
                .rounded-2xl { border-radius: 20px; }
                .rounded-full { border-radius: 50%; }
            `}
        </style>
    );
};
