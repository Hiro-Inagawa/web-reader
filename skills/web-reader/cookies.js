/**
 * Browser cookie extraction for authenticated web reading.
 *
 * Extracts cookies from installed browsers and returns them in
 * Playwright-compatible format for injection into browser contexts.
 *
 * Supported:
 *   Windows: Chrome, Edge, Brave, Firefox
 *   macOS:   Firefox (Chrome needs Keychain - future)
 *   Linux:   Firefox (Chrome needs libsecret - future)
 *
 * Chrome/Edge/Brave cookies are encrypted with DPAPI (Windows).
 * Firefox cookies are stored in plain text SQLite.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');

// --- Browser cookie database paths ---

function getBrowserPaths(browser, profile) {
  const platform = process.platform;
  const profileDir = profile || 'Default';

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const roaming = process.env.APPDATA;

    const chromiumPaths = {
      chrome: {
        cookies: path.join(local, 'Google', 'Chrome', 'User Data', profileDir, 'Network', 'Cookies'),
        localState: path.join(local, 'Google', 'Chrome', 'User Data', 'Local State'),
      },
      edge: {
        cookies: path.join(local, 'Microsoft', 'Edge', 'User Data', profileDir, 'Network', 'Cookies'),
        localState: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Local State'),
      },
      brave: {
        cookies: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', profileDir, 'Network', 'Cookies'),
        localState: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Local State'),
      },
    };

    if (chromiumPaths[browser]) {
      return { ...chromiumPaths[browser], type: 'chromium' };
    }

    if (browser === 'firefox') {
      return {
        profilesDir: path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'),
        profilesIni: path.join(roaming, 'Mozilla', 'Firefox', 'profiles.ini'),
        type: 'firefox',
      };
    }
  }

  if (platform === 'darwin') {
    const home = os.homedir();
    if (browser === 'firefox') {
      return {
        profilesDir: path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
        profilesIni: path.join(home, 'Library', 'Application Support', 'Firefox', 'profiles.ini'),
        type: 'firefox',
      };
    }
    if (['chrome', 'edge', 'brave'].includes(browser)) {
      throw new Error(browser + ' cookie extraction on macOS requires Keychain access (not yet supported). Use firefox or --cookies file instead.');
    }
  }

  if (platform === 'linux') {
    const home = os.homedir();
    if (browser === 'firefox') {
      return {
        profilesDir: path.join(home, '.mozilla', 'firefox'),
        profilesIni: path.join(home, '.mozilla', 'firefox', 'profiles.ini'),
        type: 'firefox',
      };
    }
    if (['chrome', 'edge', 'brave'].includes(browser)) {
      throw new Error(browser + ' cookie extraction on Linux requires libsecret (not yet supported). Use firefox or --cookies file instead.');
    }
  }

  throw new Error('Unsupported browser: ' + browser + '. Use chrome, edge, brave, or firefox.');
}

// --- DPAPI decryption (Windows only) ---

function decryptDPAPI(encryptedBuffer) {
  const b64Input = encryptedBuffer.toString('base64');
  const tmpScript = path.join(os.tmpdir(), 'wr-dpapi-' + process.pid + '.ps1');

  fs.writeFileSync(tmpScript, [
    'Add-Type -AssemblyName System.Security',
    "$bytes = [Convert]::FromBase64String('" + b64Input + "')",
    '$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)',
  ].join('\n'));

  try {
    const result = childProcess.execSync(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + tmpScript + '"',
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return Buffer.from(result, 'base64');
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }
}

// --- Chromium AES-256-GCM cookie decryption ---

function getChromiumMasterKey(localStatePath) {
  if (!fs.existsSync(localStatePath)) {
    throw new Error('Local State file not found: ' + localStatePath);
  }

  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encryptedKeyB64 = localState.os_crypt?.encrypted_key;

  if (!encryptedKeyB64) {
    throw new Error('No encrypted_key found in Local State');
  }

  // Base64 decode, strip "DPAPI" prefix (5 bytes)
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  const prefix = encryptedKey.slice(0, 5).toString('utf8');
  if (prefix !== 'DPAPI') {
    throw new Error('Unexpected key prefix: ' + prefix);
  }

  return decryptDPAPI(encryptedKey.slice(5));
}

function decryptCookieValue(encryptedValue, masterKey) {
  if (!encryptedValue || encryptedValue.length === 0) {
    return '';
  }

  const prefix = encryptedValue.slice(0, 3).toString('utf8');

  // v10 or v20 = AES-256-GCM encrypted
  if (prefix === 'v10' || prefix === 'v20') {
    const nonce = encryptedValue.slice(3, 15); // 12 bytes
    const ciphertextWithTag = encryptedValue.slice(15);
    const authTag = ciphertextWithTag.slice(-16); // last 16 bytes
    const ciphertext = ciphertextWithTag.slice(0, -16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  }

  // Old unencrypted format or DPAPI-only (pre Chrome 80)
  if (encryptedValue[0] === 0x01 && encryptedValue[1] === 0x00) {
    return decryptDPAPI(encryptedValue).toString('utf8');
  }

  // Plain text
  return encryptedValue.toString('utf8');
}

// --- Chrome timestamp conversion ---

function chromeTimeToUnix(chromeTime) {
  if (!chromeTime || chromeTime === 0) return -1; // session cookie
  // Chrome: microseconds since Jan 1, 1601
  // Unix: seconds since Jan 1, 1970
  return Math.floor(Number(chromeTime) / 1000000) - 11644473600;
}

// --- SameSite mapping ---

function chromeSameSite(value) {
  switch (value) {
    case 0: return 'None';     // no_restriction
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';    // unspecified defaults to Lax
  }
}

function firefoxSameSite(value) {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}

// --- SQLite reading via Python subprocess (handles WAL + locked files natively) ---

function queryBrowserDB(dbPath, domain, dbType) {
  if (!fs.existsSync(dbPath)) {
    throw new Error('Cookie database not found: ' + dbPath);
  }

  const scriptPath = path.join(__dirname, 'query-cookies.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error('query-cookies.py not found at: ' + scriptPath);
  }

  let stdout, stderr;
  try {
    const result = childProcess.execSync(
      'python ' + JSON.stringify(scriptPath) + ' ' +
      JSON.stringify(dbPath) + ' ' +
      JSON.stringify(domain) + ' ' +
      JSON.stringify(dbType),
      { encoding: 'utf8', timeout: 30000 }
    );
    stdout = result;
  } catch (e) {
    // The Python script outputs a JSON error to stdout before exiting
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    if (stderr) {
      console.error('[cookies] ' + stderr.trim());
    }
  }

  const trimmed = (stdout || '').trim();
  if (!trimmed) {
    throw new Error('Cookie extraction failed. The browser may have its database locked. Close the browser briefly and retry, or use --cookies with a cookie file.');
  }

  const parsed = JSON.parse(trimmed);
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

// --- Chromium cookie extraction ---

function decryptChromiumRows(rows, masterKey, domain) {
  const cookies = [];
  for (const row of rows) {
    try {
      const encryptedBuf = row.encrypted_value?.__bytes__
        ? Buffer.from(row.encrypted_value.__bytes__, 'base64')
        : Buffer.from(row.encrypted_value || '', 'utf8');

      const value = decryptCookieValue(encryptedBuf, masterKey);
      if (!value) continue;

      cookies.push({
        name: row.name,
        value: value,
        domain: row.host_key,
        path: row.path || '/',
        expires: chromeTimeToUnix(row.expires_utc),
        httpOnly: Boolean(row.is_httponly),
        secure: Boolean(row.is_secure),
        sameSite: chromeSameSite(row.samesite),
      });
    } catch (e) {
      console.error('[cookies] Failed to decrypt cookie ' + row.name + ': ' + e.message);
    }
  }
  return cookies;
}

function findChromiumProfiles(browser) {
  const local = process.env.LOCALAPPDATA;
  const baseDirs = {
    chrome: path.join(local, 'Google', 'Chrome', 'User Data'),
    edge: path.join(local, 'Microsoft', 'Edge', 'User Data'),
    brave: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  };
  const baseDir = baseDirs[browser];
  if (!baseDir || !fs.existsSync(baseDir)) return ['Default'];

  const profiles = [];
  const entries = fs.readdirSync(baseDir);
  for (const entry of entries) {
    if (entry === 'Default' || entry.startsWith('Profile ')) {
      const cookieDb = path.join(baseDir, entry, 'Network', 'Cookies');
      if (fs.existsSync(cookieDb)) {
        profiles.push(entry);
      }
    }
  }
  return profiles.length > 0 ? profiles : ['Default'];
}

async function getChromiumCookies(browser, domain, profile) {
  if (process.platform !== 'win32') {
    throw new Error(browser + ' cookie extraction is currently Windows-only. Use firefox or --cookies file on ' + process.platform + '.');
  }

  const paths = getBrowserPaths(browser, profile);
  const label = profile ? browser + ' (' + profile + ')' : browser;
  console.error('[cookies] Extracting ' + label + ' cookies for ' + domain);

  // Get the master decryption key (shared across profiles)
  const masterKey = getChromiumMasterKey(paths.localState);
  console.error('[cookies] Master key decrypted');

  // Query the cookie database via Python (handles WAL + file locks)
  let rows;
  try {
    rows = queryBrowserDB(paths.cookies, domain, 'chromium');
  } catch (e) {
    rows = [];
    console.error('[cookies] ' + e.message);
  }

  let cookies = decryptChromiumRows(rows, masterKey, domain);

  // Auto-scan other profiles if no cookies found and no specific profile requested
  if (cookies.length === 0 && !profile) {
    const allProfiles = findChromiumProfiles(browser);
    const otherProfiles = allProfiles.filter(p => p !== 'Default');

    if (otherProfiles.length > 0) {
      console.error('[cookies] No cookies in Default profile, scanning ' + otherProfiles.length + ' other profile(s)...');

      let lockedProfile = null;
      for (const p of otherProfiles) {
        try {
          const altPaths = getBrowserPaths(browser, p);
          const altRows = queryBrowserDB(altPaths.cookies, domain, 'chromium');
          const altCookies = decryptChromiumRows(altRows, masterKey, domain);

          if (altCookies.length > 0) {
            console.error('[cookies] Found ' + altCookies.length + ' cookies in ' + p);
            cookies = altCookies;
            break;
          }
        } catch (e) {
          if (e.message.includes('exclusively locked') || e.message.includes('Cannot read')) {
            lockedProfile = p;
            console.error('[cookies] ' + p + ' is locked (active profile). Cookies are likely here.');
          } else {
            console.error('[cookies] Skipping ' + p + ': ' + e.message);
          }
        }
      }

      if (cookies.length === 0 && lockedProfile) {
        console.error('[cookies] Your cookies are in ' + lockedProfile + ' but Chrome has it locked.');
        console.error('[cookies] Options: (1) Close Chrome briefly and retry, or');
        console.error('[cookies]          (2) Use --cookies-from "' + browser + ':' + lockedProfile + '" after closing Chrome, or');
        console.error('[cookies]          (3) Export cookies to a file and use --cookies <file>');
      }
    }
  }

  console.error('[cookies] Extracted ' + cookies.length + ' cookies for ' + domain);
  return cookies;
}

// --- Firefox cookie extraction ---

function findFirefoxDefaultProfile(profilesIni, profilesDir) {
  if (!fs.existsSync(profilesIni)) {
    throw new Error('Firefox profiles.ini not found: ' + profilesIni);
  }

  const ini = fs.readFileSync(profilesIni, 'utf8');
  const lines = ini.split(/\r?\n/);

  let currentPath = null;
  let currentIsRelative = true;
  let currentDefault = false;
  let firstProfile = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[')) {
      // Save previous section if it was default
      if (currentPath && currentDefault) {
        return currentIsRelative ? path.join(profilesDir, '..', currentPath) : currentPath;
      }
      // Reset for new section
      if (currentPath && !firstProfile) {
        firstProfile = { path: currentPath, isRelative: currentIsRelative };
      }
      currentPath = null;
      currentIsRelative = true;
      currentDefault = false;
      continue;
    }

    const [key, ...rest] = trimmed.split('=');
    const val = rest.join('=');

    if (key === 'Path') currentPath = val;
    if (key === 'IsRelative') currentIsRelative = val === '1';
    if (key === 'Default' && val === '1') currentDefault = true;
  }

  // Check last section
  if (currentPath && currentDefault) {
    return currentIsRelative ? path.join(profilesDir, '..', currentPath) : currentPath;
  }

  // Fallback: use the first profile found
  if (firstProfile) {
    const p = firstProfile.isRelative ? path.join(profilesDir, '..', firstProfile.path) : firstProfile.path;
    return p;
  }

  // Last resort: find any profile directory with cookies.sqlite
  if (fs.existsSync(profilesDir)) {
    const entries = fs.readdirSync(profilesDir);
    for (const entry of entries) {
      const candidate = path.join(profilesDir, entry, 'cookies.sqlite');
      if (fs.existsSync(candidate)) {
        return path.join(profilesDir, entry);
      }
    }
  }

  throw new Error('No Firefox profile found');
}

async function getFirefoxCookies(domain) {
  const paths = getBrowserPaths('firefox');
  console.error('[cookies] Extracting firefox cookies for ' + domain);

  const profileDir = findFirefoxDefaultProfile(paths.profilesIni, paths.profilesDir);
  const cookieDb = path.join(profileDir, 'cookies.sqlite');
  console.error('[cookies] Using profile: ' + profileDir);

  // Query via Python (handles WAL + file locks)
  const rows = queryBrowserDB(cookieDb, domain, 'firefox');

  const cookies = [];
  for (const row of rows) {
    cookies.push({
      name: row.name,
      value: row.value,
      domain: row.host,
      path: row.path || '/',
      expires: row.expiry || -1,
      httpOnly: Boolean(row.isHttpOnly),
      secure: Boolean(row.isSecure),
      sameSite: firefoxSameSite(row.sameSite),
    });
  }

  console.error('[cookies] Extracted ' + cookies.length + ' cookies for ' + domain);
  return cookies;
}

// --- Netscape cookie file parser ---

function parseCookieFile(filePath, domain) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Cookie file not found: ' + filePath);
  }

  console.error('[cookies] Reading cookie file: ' + filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const cookies = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    const [cookieDomain, , cookiePath, secure, expiry, name, value] = parts;

    // Filter by domain if specified
    if (domain && !cookieDomain.includes(domain)) continue;

    cookies.push({
      name: name,
      value: value,
      domain: cookieDomain,
      path: cookiePath || '/',
      expires: parseInt(expiry) || -1,
      httpOnly: false, // Netscape format doesn't track httpOnly
      secure: secure.toUpperCase() === 'TRUE',
      sameSite: 'None',
    });
  }

  console.error('[cookies] Parsed ' + cookies.length + ' cookies from file');
  return cookies;
}

// --- Main entry point ---

async function extractCookies(source, domain) {
  // If source is a file path, parse as cookie file
  if (source.includes('/') || source.includes('\\') || source.endsWith('.txt') || source.endsWith('.json')) {
    return parseCookieFile(source, domain);
  }

  // Parse browser:profile syntax (e.g., "chrome:Profile 2")
  let browser, profile;
  const colonIdx = source.indexOf(':');
  if (colonIdx > 0) {
    browser = source.slice(0, colonIdx).toLowerCase();
    profile = source.slice(colonIdx + 1);
  } else {
    browser = source.toLowerCase();
    profile = null;
  }

  if (browser === 'firefox') {
    return await getFirefoxCookies(domain);
  }

  if (['chrome', 'edge', 'brave'].includes(browser)) {
    return await getChromiumCookies(browser, domain, profile);
  }

  throw new Error('Unknown cookie source: ' + source + '. Use chrome, edge, brave, firefox, or a path to a cookie file.');
}

module.exports = {
  extractCookies,
  getBrowserPaths,
  getChromiumMasterKey,
  decryptCookieValue,
  decryptDPAPI,
  getChromiumCookies,
  getFirefoxCookies,
  parseCookieFile,
  findFirefoxDefaultProfile,
  queryBrowserDB,
  chromeTimeToUnix,
  chromeSameSite,
  firefoxSameSite,
};
