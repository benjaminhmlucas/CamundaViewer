//#region [================== DEPENDENCIES AND SETUP ==================]
/**
 * Express.js server for the Camunda Viewer application.
 * Provides diagram file serving, shell data fetching, and process history management.
 * This server bridges the web frontend with Camunda APIs via PowerShell scripts.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { exec } = require('child_process');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

// Rate limiter for fetch-process endpoint: 10 requests per minute
const fetchProcessLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 requests per minute
  message: 'Too many requests to fetch-process endpoint, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for deserialize-variable endpoint: 60 requests per minute (1 per second)
const deserializeVarLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // max 60 requests per minute (allowing 1 per second)
  message: 'Too many requests to deserialize-variable endpoint, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper: get proper PowerShell executable across platforms
function getPowerShellExe() {
  const isWindows = process.platform === 'win32';
  return isWindows ? 'powershell.exe' : 'pwsh';
}

// Security middleware: validate sessionId format
function validateSessionId(req, res, next) {
  const sessionId = req.params.sessionId || req.query.sessionId || req.body.sessionId;
  if (sessionId && !/^[a-zA-Z0-9\-_]{8,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }
  next();
}

// Security function: sanitize output to prevent credential/sensitive data leaks
function sanitizeOutput(output, isStderr = false) {
  if (!output || typeof output !== 'string') return '';
  
  // Enhanced stderr handling for production
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isStderr && isProduction) {
    // In production, heavily trim stderr to prevent information disclosure
    const sanitized = output
      .replace(/password[=:\s]+[^\s\n\r]+/gi, 'password=***REDACTED***')
      .replace(/apikey[=:\s]+[^\s\n\r]+/gi, 'apikey=***REDACTED***')
      .replace(/connectionstring[=:\s]+[^\s\n\r]+/gi, 'connectionstring=***REDACTED***')
      .replace(/token[=:\s]+[^\s\n\r]+/gi, 'token=***REDACTED***')
      .replace(/secret[=:\s]+[^\s\n\r]+/gi, 'secret=***REDACTED***')
      .replace(/key[=:\s]+[^\s\n\r]+/gi, 'key=***REDACTED***')
      // Remove file paths that might contain usernames or sensitive directory structures
      .replace(/[C-Z]:\\[^\s\n\r]+/gi, '[PATH_REDACTED]')
      .replace(/\/[^\s\n\r]*\/[^\s\n\r]*/gi, '[PATH_REDACTED]')
      // Limit stderr to first line only in production
      .split('\n')[0]
      .substring(0, 100); // Shorter limit for stderr in production
    
    return sanitized || 'Error occurred (details suppressed in production)';
  }
  
  // Standard sanitization for stdout or development mode
  return output
    .replace(/password[=:\s]+[^\s\n\r]+/gi, 'password=***REDACTED***')
    .replace(/apikey[=:\s]+[^\s\n\r]+/gi, 'apikey=***REDACTED***')
    .replace(/connectionstring[=:\s]+[^\s\n\r]+/gi, 'connectionstring=***REDACTED***')
    .replace(/token[=:\s]+[^\s\n\r]+/gi, 'token=***REDACTED***')
    .replace(/secret[=:\s]+[^\s\n\r]+/gi, 'secret=***REDACTED***')
    .replace(/key[=:\s]+[^\s\n\r]+/gi, 'key=***REDACTED***')
    // Limit output length for security
    .substring(0, isStderr ? 300 : 200); // Slightly longer limit for stderr in dev mode
}
//#endregion

//#region [================== GLOBAL STATE MANAGEMENT ==================]
/**
 * Application state variables for environment selection and configuration.
 * The selected environment determines which config file is used for Camunda API connections.
 */
let selectedEnvironment = 'local'; // Current active environment for PowerShell connections
//#endregion

//#region [================== IN-MEMORY DATA STORAGE ==================]
/**
 * Session-based in-memory storage for diagram data to prevent PII from being stored on disk.
 * Each session represents a tab/process combination, allowing multiple processes to be viewed simultaneously.
 * This is especially important for environments that sync to OneDrive or other cloud storage.
 */
const sessionStorage = new Map(); // Map<sessionId, sessionData>
const activeSessions = new Set(); // Track active session IDs

/**
 * Create a new session with empty storage containers
 */
function createSession(sessionId) {
  const sessionData = {
    diagrams: new Map(), // Map<filename, content> for BPMN/DMN files
    executionData: new Map(), // Map<filename, jsonData> for execution data
    variableChunks: new Map(), // Map<filename, jsonData> for variable chunks
    variableSummaries: new Map(), // Map<filename, jsonData> for variable summaries
    currentBusinessKey: null, // Store the current business key for this session
    currentEnvironment: 'local', // Store the current environment for this session
    sessionLog: [], // Array of log entries for this session
    lastUpdated: null,
    createdAt: new Date().toISOString()
  };
  
  sessionStorage.set(sessionId, sessionData);
  activeSessions.add(sessionId);
  console.log(`Created new session: ${sessionId}`);
  return sessionData;
}

/**
 * Get session data, creating if it doesn't exist
 */
function getSession(sessionId) {
  if (!sessionStorage.has(sessionId)) {
    return createSession(sessionId);
  }
  return sessionStorage.get(sessionId);
}

/**
 * Session log management functions
 */
function addToSessionLog(sessionId, message, type = 'info') {
  const session = getSession(sessionId);
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    type,
    message
  };
  session.sessionLog.push(logEntry);
  
  // Keep log size manageable (last 5000 entries)
  if (session.sessionLog.length > 5000) {
    session.sessionLog = session.sessionLog.slice(-5000);
  }
}

function clearSessionLog(sessionId) {
  const session = getSession(sessionId);
  session.sessionLog = [];
}

function getSessionLog(sessionId) {
  const session = getSession(sessionId);
  return session.sessionLog || [];
}

function formatSessionLogForViewing(sessionId) {
  const logEntries = getSessionLog(sessionId);
  if (logEntries.length === 0) {
    return 'No log entries for this session.';
  }
  
  return logEntries.map(entry => {
    const time = new Date(entry.timestamp).toLocaleString();
    const typePrefix = entry.type.toUpperCase().padEnd(5);
    return `[${time}] ${typePrefix}: ${entry.message}`;
  }).join('\n');
}

/**
 * Generate a cryptographically secure session ID using Node.js crypto module
 * @returns {string} A secure session ID with timestamp and cryptographically secure random component
 */
function generateSessionId() {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(9); // 9 bytes for similar length to original
  const randomString = randomBytes.toString('base64').replace(/[+/=]/g, '').substring(0, 9);
  return `session_${timestamp}_${randomString}`;
}

/**
 * Update session heartbeat to mark it as active
 */
function updateSessionHeartbeat(sessionId) {
  const sessionData = sessionStorage.get(sessionId);
  if (sessionData) {
    sessionData.lastHeartbeat = Date.now();
  }
}
//#endregion

//#region [================== PROCESS HISTORY FILE MANAGEMENT ==================]
/**
 * File-based process history management since business keys are not considered PII.
 * Stores up to 5 business keys per environment in a text file format.
 */
const PROCESS_HISTORY_FILE = 'process-history.txt';

/**
 * Read process history from text file.
 * Format: [Environment]\nbusinessKey1\nbusinessKey2\n...\n[NextEnvironment]\n...
 */
function readProcessHistoryFromFile() {
  try {
    if (!fs.existsSync(PROCESS_HISTORY_FILE)) {
      return { selected: selectedEnvironment, environments: {} };
    }
    
    const content = fs.readFileSync(PROCESS_HISTORY_FILE, 'utf8');
    const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    const history = { selected: selectedEnvironment, environments: {} };
    let currentEnv = null;
    
    for (const line of lines) {
      if (line.startsWith('[') && line.endsWith(']')) {
        // Environment section header
        currentEnv = line.slice(1, -1);
        history.environments[currentEnv] = [];
      } else if (currentEnv && line.length > 0) {
        // Business Key (allow any non-empty value)
        history.environments[currentEnv].push(line);
      } else if (line.startsWith('SELECTED=')) {
        // Selected environment
        history.selected = line.substring(9);
      }
    }
    
    return history;
  } catch (error) {
    console.error('Error reading process history file:', error);
    return { selected: selectedEnvironment, environments: {} };
  }
}

/**
 * Write process history to text file.
 * Automatically detects environments from config-*.cfg files.
 * Creates the file if it doesn't exist.
 */
function writeProcessHistoryToFile(history) {
  try {
    // Get available environments from config files
    const availableEnvs = getAvailableEnvironments();
    
    // If no environments found, create a basic structure with local
    if (availableEnvs.length === 0) {
      availableEnvs.push('local');
    }
    
    let content = `SELECTED=${history.selected}\n\n`;
    
    // Write each environment section
    for (const env of availableEnvs) {
      content += `[${env}]\n`;
      const envHistory = history.environments[env] || [];
      for (const businessKey of envHistory) {
        if (businessKey && businessKey.length > 0) {
          content += `${businessKey}\n`;
        }
      }
      content += '\n';
    }
    
    // Ensure directory exists and write file
    fs.writeFileSync(PROCESS_HISTORY_FILE, content, 'utf8');
    console.log(` Updated process history file: ${PROCESS_HISTORY_FILE}`);
    return true;
  } catch (error) {
    console.error('Error writing process history file:', error);
    return false;
  }
}

/**
 * Get available environments by reading config-*.cfg files.
 * Returns array of environment names extracted from filenames.
 */
function getAvailableEnvironments() {
  try {
    const files = fs.readdirSync(__dirname);
    const configFiles = files.filter(f => f.startsWith('config-') && f.endsWith('.cfg'));
    return configFiles.map(f => {
      // Extract environment name: config-{env}.cfg -> {env}
      return f.substring(7, f.length - 4); // Remove 'config-' and '.cfg'
    }).sort();
  } catch (error) {
    console.error('Error reading available environments:', error);
    return ['local']; // Default fallback
  }
}

/**
 * Add business key to history and maintain 5 most recent per environment.
 */
function addProcessToHistory(environment, businessKey) {
  if (!environment || !businessKey) {
    return false;
  }
  
  const history = readProcessHistoryFromFile();
  
  // Initialize environment if not exists
  if (!history.environments[environment]) {
    history.environments[environment] = [];
  }
  
  const envHistory = history.environments[environment];
  
  // Remove existing instance of this business key
  const filtered = envHistory.filter(id => id !== businessKey);
  
  // Add to front and keep only 5 most recent
  filtered.unshift(businessKey);
  history.environments[environment] = filtered.slice(0, 5);
  
  // Update selected environment
  history.selected = environment;
  
  return writeProcessHistoryToFile(history);
}
//#endregion

//#region [================== EXPRESS MIDDLEWARE SETUP ==================]
/**
 * Configure Express middleware for request parsing and security.
 * Enables JSON request body parsing for API endpoints with increased size limit for large DMN files.
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
//#endregion

//#region [================== STATIC FILE SERVING ==================]
/**
 * Configure static file serving for the web application.
 * Serves the main HTML interface and JavaScript libraries.
 * - Root directory: serves viewer.html and config files
 * - /lib: serves bpmn-js and dmn-js viewer libraries
 * Note: Diagram files are served from memory to protect PII data
 */
app.use(express.static(__dirname)); // Main application files (viewer.html, configs)
app.use('/lib', express.static(path.join(__dirname, 'lib'))); // Viewer libraries
//#endregion

//#region [================== MAIN APPLICATION ROUTE ==================]
/**
 * Serve the main Camunda Viewer interface at the root URL.
 * This is the primary entry point for users accessing the application.
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});
//#endregion

//#region [================== SESSION MANAGEMENT ==================]
/**
 * API endpoints for managing user sessions and multi-tab support.
 * Each session represents a separate process/environment combination.
 */

// Generate a new session ID
app.post('/new-session', (req, res) => {
  const sessionId = generateSessionId();
  const sessionData = createSession(sessionId);
  
  res.json({ 
    sessionId: sessionId,
    message: 'New session created',
    createdAt: sessionData.createdAt
  });
});

// Get session information
app.get('/session/:sessionId', validateSessionId, (req, res) => {
  const sessionId = req.params.sessionId;
  
  if (!sessionStorage.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const sessionData = sessionStorage.get(sessionId);
  res.json({
    sessionId: sessionId,
    currentBusinessKey: sessionData.currentBusinessKey,
    currentEnvironment: sessionData.currentEnvironment,
    lastUpdated: sessionData.lastUpdated,
    createdAt: sessionData.createdAt,
    diagramCount: sessionData.diagrams.size,
    executionDataCount: sessionData.executionData.size,
    variableChunkCount: sessionData.variableChunks.size
  });
});

// List all active sessions
app.get('/sessions', (req, res) => {
  const sessions = Array.from(activeSessions).map(sessionId => {
    const sessionData = sessionStorage.get(sessionId);
    return {
      sessionId: sessionId,
      currentBusinessKey: sessionData.currentBusinessKey,
      currentEnvironment: sessionData.currentEnvironment,
      lastUpdated: sessionData.lastUpdated,
      createdAt: sessionData.createdAt,
      diagramCount: sessionData.diagrams.size
    };
  });
  
  res.json({ sessions: sessions });
});

// Clear/delete a specific session
app.delete('/session/:sessionId', validateSessionId, (req, res) => {
  const sessionId = req.params.sessionId;
  
  if (!sessionStorage.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const sessionData = sessionStorage.get(sessionId);
  const diagramCount = sessionData.diagrams.size;
  const executionDataCount = sessionData.executionData.size;
  const variableChunkCount = sessionData.variableChunks.size;
  
  sessionStorage.delete(sessionId);
  activeSessions.delete(sessionId);
  
  console.log(`Deleted session ${sessionId}: ${diagramCount} diagrams, ${executionDataCount} execution files, ${variableChunkCount} variable chunks`);
  
  res.json({ 
    message: 'Session deleted',
    sessionId: sessionId,
    clearedFiles: diagramCount + executionDataCount + variableChunkCount
  });
});

// Session heartbeat to mark session as active
app.post('/session/:sessionId/heartbeat', validateSessionId, (req, res) => {
  const sessionId = req.params.sessionId;
  
  if (!sessionStorage.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  updateSessionHeartbeat(sessionId);
  res.json({ message: 'Heartbeat updated', sessionId: sessionId });
});
//#endregion

//#region [================== DIAGRAM FILE MANAGEMENT ==================]
/**
 * API endpoints for managing and serving process diagram files.
 * All diagram data is stored in memory to protect PII from being written to disk.
 * This prevents sensitive data from syncing to OneDrive or other cloud storage.
 */

/**
 * List all available diagram files from memory storage.
 * Returns only BPMN and DMN files for the file browser interface.
 * Used by the frontend to populate the process hierarchy after data fetching.
 * Supports session-based storage for multi-tab functionality.
 */
app.get('/list', (req, res) => {
  try {
    // Get session ID from query parameter - required for multi-tab support
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
    }
    
    const sessionData = getSession(sessionId);
    
    // Update session heartbeat to mark as active
    updateSessionHeartbeat(sessionId);
    
    // Get diagram filenames from session-specific storage
    const diagramFiles = Array.from(sessionData.diagrams.keys())
      .filter(filename => filename.endsWith('.bpmn') || filename.endsWith('.dmn'));
    
    // Get execution data filenames from session-specific storage  
    const executionFiles = Array.from(sessionData.executionData.keys())
      .filter(filename => filename.endsWith('.json'));
    
    // Combine both lists and sort
    const allFiles = [...diagramFiles, ...executionFiles].sort();
    
    res.json(allFiles);
  } catch (error) {
    console.error('Failed to list diagrams from memory:', error);
    res.status(500).json({ error: 'Failed to list diagrams' });
  }
});

/**
 * Serve individual diagram files from memory storage.
 * Handles BPMN/DMN XML files and corresponding JSON execution data.
 * The frontend requests these files when users select diagrams to view.
 * Supports session-based storage for multi-tab functionality.
 */
app.get('/diagrams/:filename', (req, res) => {
  const fileName = req.params.filename;
  
  try {
    // Get session ID from query parameter - required for multi-tab support
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
    }
    
    const sessionData = getSession(sessionId);
    
    // Update session heartbeat to mark as active
    updateSessionHeartbeat(sessionId);
    
    // Serve BPMN process definition files from memory
    if (fileName.endsWith('.bpmn')) {
      const content = sessionData.diagrams.get(fileName);
      if (!content) {
        return res.status(404).json({ error: 'BPMN file not found in memory' });
      }
      res.setHeader('Content-Type', 'application/xml');
      return res.send(content);
    }

    // Serve JSON execution data from memory
    if (fileName.endsWith('.json')) {
      const data = sessionData.executionData.get(fileName);
      if (!data) {
        return res.status(404).json({ error: 'Execution data not found in memory' });
      }
      res.setHeader('Content-Type', 'application/json');
      return res.json(data);
    }

    // Serve DMN decision definition files from memory
    if (fileName.endsWith('.dmn')) {
      const content = sessionData.diagrams.get(fileName);
      if (!content) {
        return res.status(404).json({ error: 'DMN file not found in memory' });
      }
      res.setHeader('Content-Type', 'application/xml');
      return res.send(content);
    }

    // File type not supported
    res.status(400).json({ error: 'Unsupported file type' });
  } catch (error) {
    console.error('Error serving diagram file:', error);
    res.status(500).json({ error: 'Failed to serve diagram file' });
  }
});

/**
 * Store diagram data in memory (replaces file writing for PII protection).
 * This endpoint receives diagram content and execution data from the PowerShell script.
 * Supports session-based storage for multi-tab functionality.
 */
app.post('/store-diagram', validateSessionId, (req, res) => {
  try {
    const { filename, content, type, sessionId } = req.body;
    
    // Session ID is required for multi-tab support
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
    }
    
    const targetSessionId = sessionId;
    const sessionData = getSession(targetSessionId);
    
    console.log(` Storing ${type || 'diagram'} in session ${targetSessionId}: ${filename}`);
    console.log(` Content length: ${content ? content.length : 'null'} characters`);
    
    if (!filename || !content) {
      console.log(' Missing filename or content');
      return res.status(400).json({ error: 'Filename and content are required' });
    }
    
    // Store based on file type
    if (type === 'variable-chunk') {
      // Store variable chunks for later reassembly
      const jsonData = typeof content === 'string' ? JSON.parse(content) : content;
      sessionData.variableChunks.set(filename, jsonData);
      console.log(` Stored variable chunk: ${filename} (chunk ${jsonData.chunkIndex + 1}/${jsonData.totalChunks})`);
    } else if (type === 'variable-summary') {
      // Store variable summary for reassembly instructions
      const jsonData = typeof content === 'string' ? JSON.parse(content) : content;
      sessionData.variableSummaries.set(filename, jsonData);
      console.log(` Stored variable summary: ${filename} (${jsonData.totalVariables} variables in ${jsonData.totalChunks} chunks)`);
    } else if (type === 'execution-data' || filename.endsWith('.json')) {
      const jsonData = typeof content === 'string' ? JSON.parse(content) : content;
      sessionData.executionData.set(filename, jsonData);
      console.log(` Stored execution data: ${filename}`);
    } else if (filename.endsWith('.bpmn') || filename.endsWith('.dmn')) {
      sessionData.diagrams.set(filename, content);
      console.log(` Stored diagram: ${filename}`);
    } else {
      console.log(` Unsupported file type: ${type}`);
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    
    sessionData.lastUpdated = new Date().toISOString();
    res.json({ 
      success: true, 
      message: 'Data stored in memory successfully',
      type: type || 'diagram',
      sessionId: targetSessionId
    });
    
  } catch (error) {
    console.error(' Error storing diagram data:', error);
    res.status(500).json({ error: 'Failed to store diagram data' });
  }
});

/**
 * Clear all diagram data from memory.
 * Useful for starting fresh or when switching between different processes.
 */
app.post('/clear-diagrams', validateSessionId, (req, res) => {
  try {
    const sessionId = req.query.sessionId || req.body.sessionId || 'default';
    const sessionData = getSession(sessionId);
    
    const diagramCount = sessionData.diagrams.size;
    const executionDataCount = sessionData.executionData.size;
    const variableChunkCount = sessionData.variableChunks.size;
    const variableSummaryCount = sessionData.variableSummaries.size;
    
    sessionData.diagrams.clear();
    sessionData.executionData.clear();
    sessionData.variableChunks.clear();
    sessionData.variableSummaries.clear();
    sessionData.lastUpdated = new Date().toISOString();
    
    res.json({ 
      success: true, 
      message: `Cleared ${diagramCount} diagrams, ${executionDataCount} execution data, ${variableChunkCount} variable chunks, and ${variableSummaryCount} variable summaries from session ${sessionId}`,
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('Error clearing diagram data:', error);
    res.status(500).json({ error: 'Failed to clear diagram data' });
  }
});

/**
 * Get status of in-memory storage including diagrams and process history.
 * Returns information about what data is currently stored in memory.
 */
app.get('/memory-status', (req, res) => {
  try {
    // Get session data
    const sessionId = req.query.sessionId || 'default';
    const sessionData = getSession(sessionId);
    
    // Get process history from file
    const processHistory = readProcessHistoryFromFile();
    const processHistoryCount = Object.values(processHistory.environments || {})
      .reduce((total, processes) => total + processes.length, 0);
    
    const status = {
      sessionId: sessionId,
      diagramCount: sessionData.diagrams.size,
      executionDataCount: sessionData.executionData.size,
      variableChunkCount: sessionData.variableChunks.size,
      variableSummaryCount: sessionData.variableSummaries.size,
      processHistoryCount: processHistoryCount,
      processHistoryEnvironments: Object.keys(processHistory.environments || {}),
      selectedEnvironment: processHistory.selected,
      lastUpdated: sessionData.lastUpdated,
      diagrams: Array.from(sessionData.diagrams.keys()),
      executionData: Array.from(sessionData.executionData.keys())
    };
    
    res.json(status);
  } catch (error) {
    console.error('Error getting memory status:', error);
    res.status(500).json({ error: 'Failed to get memory status' });
  }
});
//#endregion

//#region [================== CAMUNDA DATA FETCHING ==================]
/**
 * PowerShell integration for fetching process execution data from Camunda.
 * This endpoint orchestrates the GetData.ps1 script and provides real-time progress updates.
 * The PowerShell script connects to Camunda APIs to retrieve process instances and decisions.
 */

/**
 * Execute PowerShell script to fetch process data from Camunda APIs.
 * Provides streaming response with progress updates and error handling.
 * Stores execution log data in session memory for process tracking and troubleshooting.
 * 
 * Request body: { businessKey: string, environment: string }
 * Response: Streaming text with JSON progress objects and completion status
 */
app.post('/fetch-process', fetchProcessLimiter, validateSessionId, (req, res) => {
  const { businessKey, environment = 'local', maxRuns = 5, sessionId } = req.body;
  
  // Validate business key (must be provided for Camunda queries)
  if (!businessKey) {
    return res.status(400).json({ error: 'Business key is required.' });
  }
  
  // Validate environment parameter
  const validEnvironments = ['local', 'dev', 'test', 'uat', 'prod'];
  if (!validEnvironments.includes(environment.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid environment. Must be one of: ' + validEnvironments.join(', ') });
  }
  
  // Validate maxRuns parameter
  const maxRunsInt = parseInt(maxRuns);
  if (isNaN(maxRunsInt) || maxRunsInt < 1 || maxRunsInt > 50) {
    return res.status(400).json({ error: 'Invalid maxRuns. Must be between 1 and 50.' });
  }
   
  // Ensure we have a session ID - if none provided, this is an error
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
  }
  
  const targetSessionId = sessionId;
  const sessionData = getSession(targetSessionId);
  
  // Add business key to history file immediately when button is pressed
  addProcessToHistory(environment, businessKey);
  
  // Store business key and environment in session for header display and deserialization
  sessionData.currentBusinessKey = businessKey;
  sessionData.currentEnvironment = environment;
  
  // Clear previous diagram data and session log before starting new fetch
  sessionData.diagrams.clear();
  sessionData.executionData.clear();
  sessionData.variableChunks.clear();
  sessionData.variableSummaries.clear();
  clearSessionLog(targetSessionId);
  
  // Add initial log entry
  addToSessionLog(targetSessionId, `Starting data fetch for Business Key: ${businessKey}`, 'info');
  addToSessionLog(targetSessionId, `Environment: ${environment}`, 'info');
  addToSessionLog(targetSessionId, `Max Runs: ${maxRunsInt}`, 'info');
  
  // Configure streaming response for real-time progress updates
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  // Launch PowerShell process with GetData.ps1 script
  // Uses platform-specific PowerShell executable:
  // - Windows: powershell.exe (Windows PowerShell 5.1)
  // - Mac/Linux: pwsh (PowerShell Core 6+)
  const scriptPath = path.join(__dirname, 'powershell', 'GetData.ps1');
  
  // Variables for tracking processing state
  
  // Determine PowerShell executable based on platform
  // const isWindows = process.platform === 'win32';
  // const powershellExe = isWindows ? 'powershell' : 'pwsh';
  const powershellExe = getPowerShellExe();
  
  const ps = spawn(powershellExe, [
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-BusinessKey', businessKey,
    '-Environment', environment,
    '-MaxRuns', maxRunsInt.toString(),
    '-SessionId', targetSessionId
  ], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8'
  });
  
  // Track progress for real-time updates to the frontend
  let processCount = 0;
  let totalProcesses = 0;
  let currentProcess = '';
  let currentDmnGroup = '';
  let dmnGroupCount = 0;
  let totalDmnGroups = 0;
  
  // Process stdout from PowerShell script for progress tracking and data parsing
  // Recognizes special progress markers and forwards updates to the frontend
  ps.stdout.on('data', (data) => {
    const output = data.toString('utf8');
    
    // Add output to session log
    const logLines = output.split('\n');
    logLines.forEach(line => {
      if (line.trim()) {
        addToSessionLog(targetSessionId, line.trim(), 'info');
      }
    });
    
    // Log raw output for encoding issues (remove line breaks for clean logging)
    const cleanOutput = output.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`[PS STDOUT] ${cleanOutput.substring(0, 200)}${cleanOutput.length > 200 ? '...' : ''}`);
    
    // Parse output for progress tracking and completion status
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Track total number of process instances to be handled
      if (trimmed.startsWith('PROGRESS_TOTAL:')) {
        totalProcesses = parseInt(trimmed.replace('PROGRESS_TOTAL:', ''));
      }
      
      // Update current progress and notify frontend
      else if (trimmed.startsWith('PROGRESS_CURRENT:')) {
        processCount = parseInt(trimmed.replace('PROGRESS_CURRENT:', ''));
        
        let progressMessage = `Saving BPMN file: ${processCount} of ${totalProcesses}`;
        if (currentDmnGroup) {
          progressMessage += ` | ${currentDmnGroup}`;
        }
        
        const progressData = {
          type: 'progress',
          current: processCount,
          total: totalProcesses,
          bpmnCurrent: processCount,
          bpmnTotal: totalProcesses,
          dmnCurrent: dmnGroupCount,
          dmnTotal: totalDmnGroups,
          message: progressMessage
        };
        res.write(JSON.stringify(progressData) + '\n');
      }
      
      // Capture DMN processing progress
      else if (trimmed.includes('Processing DMN decision group') && trimmed.includes('of')) {
        const match = trimmed.match(/Processing DMN decision group (\d+) of (\d+)/);
        if (match) {
          dmnGroupCount = parseInt(match[1]);
          totalDmnGroups = parseInt(match[2]);
          currentDmnGroup = `Saving DMN file: ${dmnGroupCount} of ${totalDmnGroups}`;
          
          const progressData = {
            type: 'progress',
            current: processCount,
            total: totalProcesses,
            bpmnCurrent: processCount,
            bpmnTotal: totalProcesses,
            dmnCurrent: dmnGroupCount,
            dmnTotal: totalDmnGroups,
            message: `Saving BPMN file: ${processCount} of ${totalProcesses} | Saving DMN file: ${dmnGroupCount} of ${totalDmnGroups}`
          };
          res.write(JSON.stringify(progressData) + '\n');
        }
      }
      
      // Capture process instance details for logging
      else if (trimmed.includes('Process Instance ID:')) {
        currentProcess = trimmed.replace('Process Instance ID:', '').trim();
        // Reset DMN tracking for new process instance
        currentDmnGroup = '';
        dmnGroupCount = 0;
        totalDmnGroups = 0;
      }
      
      // Handle completion marker from PowerShell script
      // Check for completion signal
      else if (trimmed === 'DATA_FETCH_COMPLETE') {
        const completeData = {
          type: 'complete',
          message: 'All diagrams processed successfully',
          sessionId: targetSessionId
        };
        res.write(JSON.stringify(completeData) + '\n');
      }
      
      // Forward process execution output to frontend (remove excessive line breaks but preserve single ones)
      else if (trimmed.length > 0 && !trimmed.startsWith('PROGRESS_')) {
        // Only remove excessive whitespace and multiple consecutive line breaks, keep single line breaks
        const cleanedLine = trimmed.replace(/\s+/g, ' ').trim();
        if (cleanedLine.length > 0) {
          res.write(`${cleanedLine}\n`);
        }
      }
    }
  });
  
  // Process stderr from PowerShell for connection errors and script failures
  // Provides specific handling for common Camunda connection issues
  ps.stderr.on('data', (data) => {
    const error = data.toString('utf8');
    
    // Add error to session log
    addToSessionLog(targetSessionId, `STDERR: ${error.trim()}`, 'error');
    
    console.log(`[PS STDERR] ${sanitizeOutput(error, true)}`);

    const errorLower = error.toLowerCase();
    const connectionErrors = [
      'unable to connect to the remote server',
      'the remote server returned an error',
      'the operation has timed out',
      'no such host is known',
      'connection refused',
      'network is unreachable',
      'could not establish trust relationship',
      'the underlying connection was closed',
      'name resolution failed',
      'connection timed out'
    ];
    const isConnectionError = connectionErrors.some(pattern => errorLower.includes(pattern));

    if (isConnectionError) {
      const connectionErrorData = {
        type: 'connection_error',
        message: 'Unable to Connect to the Remote Server'
      };
      res.write(JSON.stringify(connectionErrorData) + '\n');
      addToSessionLog(targetSessionId, '=== Connection failed ===', 'error');
      return;
    }

    // Always send full error details to the client
    res.write(`PS Error: ${error.trim()}\n`);
    const errorData = {
      type: 'error',
      message: error.trim()
    };
    res.write(JSON.stringify(errorData) + '\n');
  });
  
  // Handle PowerShell process completion and cleanup
  // Finalizes session log and sends completion status to frontend
  ps.on('close', (code) => {
    addToSessionLog(targetSessionId, `=== Process completed with exit code: ${code} ===`, 'info');
    
    // Send completion status based on exit code
    if (code === 0) {
      // Current business key is already stored in session data at the start of the process
      const completeData = {
        type: 'complete',
        message: 'Script completed successfully'
      };
      res.write(JSON.stringify(completeData) + '\n');
    } else {
      const errorData = {
        type: 'error',
        message: `Script failed with exit code: ${code}`
      };
      res.write(JSON.stringify(errorData) + '\n');
    }
    
    res.end();
  });
  
  // Handle PowerShell process startup errors
  ps.on('error', (err) => {
    addToSessionLog(targetSessionId, `Failed to start PowerShell process: ${err.message}`, 'error');
    
    const errorData = {
      type: 'error',
      message: `Failed to start PowerShell: ${err.message}`
    };
    res.write(JSON.stringify(errorData) + '\n');
    res.end();
  });
});
//#endregion

//#region [================== LOG MANAGEMENT ==================]
/**
 * API endpoints for accessing and managing execution logs.
 * Provides log content retrieval and temporary file viewing functionality.
 */

/**
 * Retrieve the content of the execution log.
 * Returns log content as JSON with existence flag for frontend handling.
 * Used by the log viewer and clipboard copy functionality.
 */
app.get('/get-log', validateSessionId, (req, res) => {
  const sessionId = req.query.sessionId;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  
  const logEntries = getSessionLog(sessionId);
  const formattedLog = formatSessionLogForViewing(sessionId);
  
  if (logEntries.length === 0) {
    return res.json({ content: '', exists: false });
  }
  
  res.json({ content: formattedLog, exists: true });
});

/**
 * Create a temporary log file for viewing logs in the default text editor.
 * This creates a temporary file with log content for external viewing.
 */
app.post('/view-log', validateSessionId, (req, res) => {
  const sessionId = req.body.sessionId;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  
  const logEntries = getSessionLog(sessionId);
  
  if (logEntries.length === 0) {
    return res.status(404).json({ error: 'No log entries found for this session' });
  }
  
  const formattedLog = formatSessionLogForViewing(sessionId);
  
  // Return log content as JSON response instead of creating temporary files and shell commands
  // This eliminates shell command injection risks and is more user-friendly
  res.json({ 
    success: true,
    content: formattedLog,
    sessionId: sessionId,
    timestamp: new Date().toISOString()
  });
});
//#endregion

//#region [================== CONFIGURATION MANAGEMENT ==================]
/**
 * API endpoint for discovering and managing Camunda environment configurations.
 * Scans for config-*.cfg files and provides environment selection options.
 */

/**
 * Discover available Camunda environment configuration files.
 * Returns list of config files with display names for environment selection dropdown.
 * Local environment is prioritized and given special display treatment.
 */
app.get('/config-files', (req, res) => {
  fs.readdir(__dirname, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read config files' });
    
    // Filter and process config files matching pattern config-*.cfg
    const configFiles = files
      .filter(f => f.startsWith('config-') && f.endsWith('.cfg'))
      .map(f => {
        // Extract environment name from filename (config-<env>.cfg)
        const envName = f.replace('config-', '').replace('.cfg', '');
        
        // Generate display name (local gets special treatment)
        let displayName;
        if (envName === 'local') {
          displayName = 'Local (Default)';
        } else {
          displayName = envName; // Use exact environment name
        }
        
        return {
          filename: f,
          env: envName,
          displayName: displayName
        };
      })
      .sort((a, b) => {
        // Sort with local environment first, then alphabetical
        if (a.env === 'local') return -1;
        if (b.env === 'local') return 1;
        return a.env.localeCompare(b.env);
      });
    
    res.json({ configFiles });
  });
});
//#endregion

//#region [================== PROCESS HISTORY MANAGEMENT ==================]
/**
 * API endpoints for managing business key history and environment selection.
 * Provides autocomplete functionality and stores recent business keys per environment in memory.
 * Now uses in-memory storage to prevent PII from being written to disk files.
 */

/**
 * Retrieve process history with environment-specific business key lists.
 * Returns the currently selected environment and recent business keys per environment.
 * Used for populating autocomplete dropdowns and remembering user preferences.
 * Reads from text file since business keys are not considered PII.
 */
app.get('/process-history', (req, res) => {
  try {
    const history = readProcessHistoryFromFile();
    
    // Ensure all available environments are initialized
    const availableEnvs = getAvailableEnvironments();
    let needsUpdate = false;
    
    availableEnvs.forEach(env => {
      if (!history.environments[env]) {
        history.environments[env] = [];
        needsUpdate = true;
      }
    });
    
    // Update selected environment if needed
    if (selectedEnvironment !== history.selected) {
      history.selected = selectedEnvironment;
      needsUpdate = true;
    }
    
    // Write updates if any changes were made
    if (needsUpdate) {
      writeProcessHistoryToFile(history);
    }
    
    res.json(history);
  } catch (error) {
    console.error('Error getting process history from file:', error);
    res.status(500).json({ error: 'Failed to get process history' });
  }
});

/**
 * Update process history with new business key and environment selection.
 * Maintains up to 5 recent business keys per environment and updates selected environment.
 * Stores in text file since business keys are not considered PII.
 */
app.post('/process-history', validateSessionId, (req, res) => {
  const { environment, businessKey } = req.body;
  
  if (!environment) {
    return res.status(400).json({ error: 'Environment is required' });
  }
  
  try {
    // Update selected environment
    selectedEnvironment = environment;
    
    // Add business key to history if provided
    if (businessKey && businessKey !== 'dummy') {
      const success = addProcessToHistory(environment, businessKey);
      if (!success) {
        return res.status(500).json({ error: 'Failed to save process history' });
      }
    } else {
      // Just update selected environment without adding business key
      const history = readProcessHistoryFromFile();
      history.selected = environment;
      const success = writeProcessHistoryToFile(history);
      if (!success) {
        return res.status(500).json({ error: 'Failed to save environment selection' });
      }
    }
    
    // Return updated history
    const updatedHistory = readProcessHistoryFromFile();
    res.json({ success: true, history: updatedHistory });
  } catch (error) {
    console.error('Error updating process history in file:', error);
    res.status(500).json({ error: 'Failed to update process history' });
  }
});

/**
 * Get the current business key from memory for header persistence on page refresh.
 * Returns the business key that was last successfully processed for the specified session.
 * Supports session-based storage for multi-tab functionality.
 */
app.get('/current-process', (req, res) => {
  try {
    // Get session ID from query parameter - required for multi-tab support
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
    }
    
    const sessionData = getSession(sessionId);
    
    // Update session heartbeat to mark as active
    updateSessionHeartbeat(sessionId);
    
    res.json({ 
      businessKey: sessionData.currentBusinessKey,
      sessionId: sessionId
    });
  } catch (error) {
    console.error('Error getting current business key from memory:', error);
    res.status(500).json({ error: 'Failed to get current business key' });
  }
});
//#endregion

//#region [================== EXECUTION DATA ACCESS ==================]
/**
 * API endpoints for accessing execution data including activity instances and variable history.
 * Used by the execution data viewer to display detailed process execution information.
 */

/**
 * List execution variable files for the execution data viewer.
 * Returns filenames of files containing execution variables and activity instances.
 */
app.get('/list-files', (req, res) => {
  try {
    const type = req.query.type;
    const sessionId = req.query.sessionId || 'default';
    const sessionData = getSession(sessionId);
    
    let files = [];
    
    if (type === 'execution-variables') {
      // Get execution variable files from storage
      files = Array.from(sessionData.executionData.keys())
        .filter(filename => filename.includes('-execution-variables.json'));
      
      // Auto-generate execution file entries from variable summaries
      const summaryFiles = Array.from(sessionData.variableSummaries.keys());
      
      summaryFiles.forEach(summaryFile => {
        try {
          if (summaryFile.includes('-variable-summary.json')) {
            const executionFile = summaryFile.replace('-variable-summary.json', '-execution-variables.json');
            
            if (!files.includes(executionFile)) {
              files.push(executionFile);
            }
          }
        } catch (error) {
          console.error('Error processing summary file:', summaryFile, error);
        }
      });
      
    } else {
      // Get all execution data files
      files = Array.from(sessionData.executionData.keys());
    }
    
    res.json(files);
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * Get specific file content from memory storage.
 * Used by the execution data viewer to retrieve execution data files.
 */
app.get('/get-file/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const sessionId = req.query.sessionId || 'default';
    const sessionData = getSession(sessionId);
    
    // Check if this is a request for execution variables that need to be generated from chunks
    if (filename.includes('-execution-variables.json')) {
      const generatedData = generateExecutionVariableData(sessionData, filename);
      if (generatedData) {
        return res.json(generatedData);
      }
    }
    
    const data = sessionData.executionData.get(filename);
    if (!data) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.json(data);
  } catch (error) {
    console.error('Error getting file:', error);
    res.status(500).json({ error: 'Failed to get file' });
  }
});

/**
 * Generate execution variable data from variable chunks and summaries
 */
function generateExecutionVariableData(sessionData, requestedFilename) {
  try {
    // Extract process info from filename
    const parts = requestedFilename.replace('-execution-variables.json', '').split('-');
    if (parts.length < 3) return null;
    
    const processKey = parts[0];
    const businessKey = parts[1];
    const instanceId = parts[2];
    
    // Find matching summary
    const summaryFiles = Array.from(sessionData.variableSummaries.keys());
    const matchingSummary = summaryFiles.find(file => 
      file.includes(processKey) && file.includes(businessKey) && file.includes(instanceId)
    );
    
    if (!matchingSummary) return null;
    
    const summary = sessionData.variableSummaries.get(matchingSummary);
    
    // Reassemble execution variables from chunks
    const executionVariables = [];
    for (let chunkIndex = 0; chunkIndex < summary.totalChunks; chunkIndex++) {
      const chunkFile = summary.chunkFiles[chunkIndex];
      const chunkData = sessionData.variableChunks.get(chunkFile);
      
      if (chunkData && chunkData.variables) {
        chunkData.variables.forEach(variable => {
          executionVariables.push({
            variableName: variable.name,
            variableValue: variable.value,
            variableType: variable.type,
            scope: variable.activityInstanceId ? 'local' : 'process',
            executionId: variable.activityInstanceId || instanceId,
            activityId: variable.activityInstanceId ? 'activity-' + variable.activityInstanceId : null,
            processInstanceId: instanceId
          });
        });
      }
    }
    
    return {
      executionVariables: executionVariables,
      variableHistory: [],
      activityInstances: [],
      collectionTime: new Date().toISOString(),
      processKey: processKey,
      processInstanceId: instanceId,
      businessKey: businessKey
    };
    
  } catch (error) {
    console.error('Error generating execution variable data:', error);
    return null;
  }
}
//#endregion

//#region [================== VARIABLE REASSEMBLY ==================]
/**
 * Reassemble variable chunks into complete variable arrays.
 * This endpoint combines chunked variable data that was split to avoid PowerShell JSON truncation.
 * Supports session-based storage for multi-tab functionality.
 */
app.get('/process-variables', (req, res) => {
  try {
    console.log(' Starting variable reassembly...');
    
    // Get session ID from query parameter - required for multi-tab support
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required for multi-tab support' });
    }
    
    const sessionData = getSession(sessionId);
    
    // Update session heartbeat to mark as active
    updateSessionHeartbeat(sessionId);
    
    // Find all variable summaries for this session
    const summaryFiles = Array.from(sessionData.variableSummaries.keys());
    
    if (summaryFiles.length === 0) {
      return res.json({ 
        variables: [], 
        message: 'No variable summaries found',
        totalProcesses: 0,
        sessionId: sessionId
      });
    }
    
    // Reassemble variables for all processes in this session
    const allVariables = [];
    let totalProcesses = 0;
    
    for (const summaryFile of summaryFiles) {
      const summary = sessionData.variableSummaries.get(summaryFile);
      
      // Reassemble chunks for this process
      const processVariables = [];
      
      for (let chunkIndex = 0; chunkIndex < summary.totalChunks; chunkIndex++) {
        const chunkFile = summary.chunkFiles[chunkIndex];
        const chunkData = sessionData.variableChunks.get(chunkFile);
        
        if (chunkData && chunkData.variables) {
          processVariables.push(...chunkData.variables);
        }
      }
      
      // Add process identifier to each variable for clarity
      processVariables.forEach(variable => {
        variable.processKey = summary.processKey;
        variable.processInstanceId = summary.processInstanceId;
      });
      
      allVariables.push(...processVariables);
      totalProcesses++;
    }
    
    res.json({
      variables: allVariables,
      totalVariables: allVariables.length,
      totalProcesses: totalProcesses,
      sessionId: sessionId,
      message: `Successfully reassembled ${allVariables.length} variables from ${totalProcesses} processes`
    });
    
  } catch (error) {
    console.error(' Error reassembling variables:', error);
    res.status(500).json({ error: 'Failed to reassemble variables' });
  }
});

//#region [================== VARIABLE DESERIALIZATION ==================]
/**
 * Deserialize individual Java serialized variables using Camunda REST API.
 * This endpoint calls the Camunda API to get the deserialized value of a specific variable.
 */
app.post('/deserialize-variable', deserializeVarLimiter, validateSessionId, (req, res) => {
  try {
    const { variableName, processKey, processInstanceId } = req.body;
    
    // Validate required parameters
    if (!variableName || typeof variableName !== 'string' || variableName.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid variableName parameter' 
      });
    }
    
    if (!processKey || typeof processKey !== 'string' || processKey.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid processKey parameter' 
      });
    }
    
    if (!processInstanceId || !/^[a-f0-9\-]{8,64}$/i.test(processInstanceId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid processInstanceId parameter' 
      });
    }
    
    // Get session ID from query parameter
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'sessionId is required for multi-tab support' 
      });
    }
    
    // Validate required parameters
    if (!variableName || !processKey || !processInstanceId) {
      return res.status(400).json({ 
        success: false, 
        error: 'variableName, processKey, and processInstanceId are required' 
      });
    }
    
    // Get session data to access current process and environment
    const sessionData = getSession(sessionId);
    updateSessionHeartbeat(sessionId);
    
    // Get the environment for this session
    const environment = sessionData.currentEnvironment || 'local';
    
    const powershellExe = getPowerShellExe();
    console.log(`[GetVariableById] Starting deserialization for variable: ${variableName}`);
    console.log(`[GetVariableById] Process: ${processKey}, Instance: ${processInstanceId}, Environment: ${environment}`);
    console.log(`[GetVariableById] PowerShell executable: ${powershellExe}`);
    console.log(`[GetVariableById] Platform: ${process.platform}`);
    
    // Build the PowerShell command to deserialize the variable
    const scriptPath = path.join(__dirname, 'powershell', 'GetVariableById.ps1');
    
    console.log(`[GetVariableById] Script path: ${scriptPath}`);
    console.log(`[GetVariableById] Working directory: ${__dirname}`);
    
    const args = [
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-environment', environment,
      '-processInstanceId', processInstanceId,
      '-variableName', variableName,
      '-outputJson'
    ];
    
    console.log(`[GetVariableById] Full command: ${powershellExe} ${args.join(' ')}`);
    
    // Execute PowerShell script (cross-platform) - use -File for better execution policy handling
    const psProcess = spawn(powershellExe, args, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    psProcess.stdout.on('data', (data) => { 
      const chunk = data.toString();
      output += chunk;
    });
    
    psProcess.stderr.on('data', (data) => { 
      const chunk = data.toString();
      errorOutput += chunk;
      console.error(`[GetVariableById STDERR] ${chunk.trim()}`);
    });

    psProcess.on('close', (code) => {
      console.log(`[GetVariableById] Process completed with exit code: ${code}`);
      console.log(`[GetVariableById] Full stdout length: ${output.length} characters`);
      console.log(`[GetVariableById] Full stderr length: ${errorOutput.length} characters`);
      
      if (errorOutput.length > 0) {
        console.error(`[GetVariableById] Complete stderr output:\n${errorOutput}`);
      }
      
      if (code === 0) {
        try {
          const trimmedOutput = output.trim();
          console.log(`[GetVariableById] Attempting to parse JSON output (${trimmedOutput.length} characters)`);
          const result = JSON.parse(trimmedOutput);
          console.log(`[GetVariableById] Variable deserialization successful for ${variableName}`);
          res.json({
            success: true,
            value: result.value,
            objectType: result.objectType || result.type,
            variableName,
            processKey,
            processInstanceId
          });
        } catch (parseError) {
          console.error('[GetVariableById] Failed to parse PowerShell output for %s:', variableName, parseError);
          console.error(`[GetVariableById] Raw output that failed to parse: "${output}"`);
          console.error(`[GetVariableById] Parse error details:`, parseError.message);
          console.error('Raw output:', sanitizeOutput(output));
          res.json({
            success: false,
            error: `Failed to parse deserialization result: ${parseError.message}`,
            exitCode: code
          });
        }
      } else {
        console.error(' PowerShell script failed for %s with code %d', variableName, code);
        console.error('Error output:', sanitizeOutput(errorOutput, true));
        res.json({
          success: false,
          error: `PowerShell script failed (exit code ${code}) - check server logs for details`,
          exitCode: code
        });
      }
    });

    psProcess.on('error', (error) => {
      console.error(' Failed to start PowerShell process for %s:', variableName, error);
      res.json({ success: false, error: `Failed to start PowerShell process: ${error.message}` });
    });

  } catch (error) {
    console.error(' Error in deserialize-variable endpoint:', error);
    res.status(500).json({ success: false, error: 'Internal server error: ' + error.message });
  }
});
//#endregion

//#region [================== APPLICATION SHUTDOWN ==================]
/**
 * Gracefully shutdown the server and close browser tab.
 * This endpoint allows clean termination from the web interface.
 */
// Tab tracking for auto-shutdown detection
const activeTabs = new Set(); // Track active tab IDs

// Middleware to handle raw text data (for sendBeacon)
app.use('/deregister-tab', express.text({ type: '*/*' }));

// Register a new tab
app.post('/register-tab', (req, res) => {
  const tabId = req.body.tabId || 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  activeTabs.add(tabId);
  console.log(`📱 Tab registered: ${tabId} (total active: ${activeTabs.size})`);
  res.json({ success: true, tabId: tabId, totalTabs: activeTabs.size });
});

// Check if this is the last tab - used for popup warning
app.post('/check-last-tab', (req, res) => {
  const { tabId } = req.body;
  if (!tabId) {
    return res.status(400).json({ error: 'Tab ID is required' });
  }
  
  const isLastTab = activeTabs.has(tabId) && activeTabs.size === 1;
  res.json({ 
    isLastTab: isLastTab, 
    totalTabs: activeTabs.size,
    tabExists: activeTabs.has(tabId)
  });
});

// Deregister a tab - with auto-shutdown when last tab closes
app.post('/deregister-tab', (req, res) => {
  let tabId;
  
  // Handle both JSON and raw text data (for sendBeacon compatibility)
  if (req.is('application/json')) {
    tabId = req.body.tabId;
  } else {
    // Handle raw text data from sendBeacon
    try {
      const parsedBody = JSON.parse(req.body.toString());
      tabId = parsedBody.tabId;
    } catch (error) {
      // Fallback for URL-encoded data
      tabId = req.body.tabId;
    }
  }
  
  if (tabId) {
    activeTabs.delete(tabId);
    console.log(`📱 Tab deregistered: ${tabId} (total active: ${activeTabs.size})`);
    
    // Auto-shutdown: if no more tabs are active, wait to see if it's refresh or close
    if (activeTabs.size === 0) {
      console.log('🚪 No active tabs - waiting 2 seconds to detect refresh vs close...');
      res.json({ success: true, totalTabs: 0, autoShutdown: false });
      
      // Wait 6 seconds to see if a new tab registers (refresh/new tab) or not (close)
      setTimeout(() => {
        if (activeTabs.size === 0) {
          console.log('🚪 Confirmed: Last tab closed - initiating automatic server shutdown');
          process.exit(0);
        } else {
          console.log(`📱 Detected refresh or new tab - continuing with ${activeTabs.size} active tabs`);
        }
      }, 2000); // Increased to 6 seconds to account for longer client delays
      return;
    }
  }
  
  res.json({ success: true, totalTabs: activeTabs.size });
});

app.post('/quit', (req, res) => {
  console.log('Shutdown request received');
  
  // Send response immediately before server shutdown
  res.json({ 
    success: true, 
    message: 'Server shutting down...' 
  });
  
  // Close the server gracefully after a short delay
  setTimeout(() => {
    console.log('Shutting down Camunda Viewer server...');
    process.exit(0);
  }, 500);
});
//#endregion

//#region [================== BROWSER UTILITIES ==================]
/**
 * Cross-platform function to open the default browser to a specified URL.
 * Supports Windows, macOS, and Linux operating systems.
 * @param {string} url - The URL to open in the browser
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;
  
  switch (platform) {
    case 'win32': // Windows
      command = `start "" "${url}"`;
      break;
    case 'darwin': // macOS
      command = `open "${url}"`;
      break;
    case 'linux': // Linux
      command = `xdg-open "${url}"`;
      break;
    default:
      console.log(`  Unsupported platform: ${platform}. Please manually open ${url}`);
      return;
  }
  
  exec(command, (error) => {
    if (error) {
      console.log(`  Could not open browser automatically. Please manually open ${url}`);
      console.log(`   Error: ${error.message}`);
    } else {
      console.log(` Opened ${url} in default browser`);
    }
  });
}
//#endregion

//#region [================== SERVER STARTUP ==================]
/**
 * Start the Express server and display connection information.
 * The server runs on port 3000 and serves the Camunda Viewer application.
 * Automatically opens the default browser to the application URL.
 */
const PORT = 3000;
const URL = `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(` Camunda Viewer server started successfully!`);
  console.log(` Server running at ${URL}`);
  console.log(` Serving files from: ${__dirname}`);
  console.log(`  Started at: ${new Date().toLocaleString()}`);
   
  // Automatically open the browser after a short delay to ensure server is ready
  setTimeout(() => {
    openBrowser(URL);
  }, 1000);
});
//#endregion
