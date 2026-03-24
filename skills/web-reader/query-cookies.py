"""
Query browser cookie databases and return results as JSON.
Handles WAL journal mode and locked files natively.

Usage:
  python query-cookies.py <db_path> <domain> <type>
  type: "chromium" or "firefox"

Output: JSON array of cookie rows to stdout.
"""

import sqlite3
import json
import sys
import os
import shutil
import tempfile

def copy_with_retry(src, dst):
    """Copy a file, handling browser locks via multiple strategies."""
    if not os.path.exists(src):
        return False

    # Strategy 1: Direct copy
    try:
        shutil.copy2(src, dst)
        return True
    except (PermissionError, OSError):
        pass

    # Strategy 2: Python open (works with FILE_SHARE_READ)
    try:
        with open(src, 'rb') as f:
            data = f.read()
        with open(dst, 'wb') as f:
            f.write(data)
        return True
    except (PermissionError, OSError):
        pass

    # Strategy 3: Win32 CreateFile with all sharing flags (Windows only)
    if sys.platform == 'win32':
        try:
            import ctypes
            import ctypes.wintypes

            GENERIC_READ = 0x80000000
            FILE_SHARE_ALL = 0x07  # READ | WRITE | DELETE
            OPEN_EXISTING = 3
            FILE_ATTRIBUTE_NORMAL = 0x80

            kernel32 = ctypes.windll.kernel32
            kernel32.CreateFileW.restype = ctypes.wintypes.HANDLE
            handle = kernel32.CreateFileW(
                src, GENERIC_READ, FILE_SHARE_ALL,
                None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None
            )
            INVALID = ctypes.wintypes.HANDLE(-1).value
            if handle == INVALID:
                return False

            size = kernel32.GetFileSize(handle, None)
            buf = ctypes.create_string_buffer(size)
            bytes_read = ctypes.wintypes.DWORD(0)
            kernel32.ReadFile(handle, buf, size, ctypes.byref(bytes_read), None)
            kernel32.CloseHandle(handle)

            with open(dst, 'wb') as f:
                f.write(buf.raw[:bytes_read.value])
            return True
        except Exception:
            pass

    return False

def open_db(db_path):
    """Open a cookie database, handling browser locks.

    Strategy (same as yt-dlp):
    1. Try temp copy with WAL (full data, handles most locks)
    2. Try direct read-only mode (reads WAL in place)
    3. Try immutable mode (bypasses all locks, skips WAL)
    """
    # Strategy 1: Copy to temp and open normally (gets WAL data)
    tmp_dir = tempfile.mkdtemp(prefix='wr-cookies-')
    tmp_db = os.path.join(tmp_dir, 'cookies.db')

    try:
        main_copied = copy_with_retry(db_path, tmp_db)
        if not main_copied:
            raise Exception("Could not copy main database file")

        for ext in ['-wal', '-shm']:
            src = db_path + ext
            if os.path.exists(src):
                copy_with_retry(src, tmp_db + ext)

        conn = sqlite3.connect(tmp_db)
        conn.row_factory = sqlite3.Row
        # Verify tables exist
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if not tables:
            raise Exception("No tables found (WAL data may be inaccessible)")
        return conn, tmp_dir
    except Exception as e:
        print(f"strategy1_copy: {e}", file=sys.stderr)
        try:
            shutil.rmtree(tmp_dir)
        except OSError:
            pass

    # Strategy 2: Open with immutable flag (bypasses all locks, skips WAL)
    try:
        from urllib.parse import quote
        safe_path = quote(db_path.replace('\\', '/'), safe='/:')
        uri = 'file:' + safe_path + '?mode=ro&immutable=1'
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if not tables:
            raise Exception("No tables (empty main DB, WAL inaccessible in immutable mode)")
        print("note:using_immutable_mode", file=sys.stderr)
        return conn, None
    except Exception as e:
        print(f"strategy2_immutable: {e}", file=sys.stderr)

    # All strategies failed
    browser_name = "the browser"
    if "edge" in db_path.lower():
        browser_name = "Edge"
    elif "chrome" in db_path.lower():
        browser_name = "Chrome"
    print(json.dumps({
        "error": f"Cannot read cookie database. {browser_name} has it exclusively locked. "
                 f"Options: (1) Close {browser_name} briefly and retry, or "
                 f"(2) Use --cookies with a cookie file exported from your browser."
    }))
    sys.exit(1)


def main():
    if len(sys.argv) < 4:
        print("Usage: python query-cookies.py <db_path> <domain> <type>", file=sys.stderr)
        sys.exit(1)

    db_path = sys.argv[1]
    domain = sys.argv[2]
    db_type = sys.argv[3]  # "chromium" or "firefox"

    if not os.path.exists(db_path):
        print(json.dumps({"error": "Database not found: " + db_path}))
        sys.exit(1)

    conn, tmp_dir = open_db(db_path)

    try:
        if db_type == 'chromium':
            query = (
                "SELECT host_key, name, encrypted_value, path, expires_utc, "
                "is_secure, is_httponly, samesite "
                "FROM cookies WHERE host_key LIKE ? OR host_key LIKE ?"
            )
        else:  # firefox
            query = (
                "SELECT host, name, value, path, expiry, "
                "isSecure, isHttpOnly, sameSite "
                "FROM moz_cookies WHERE host LIKE ? OR host LIKE ?"
            )

        params = ('%' + domain, '%.' + domain)
        cursor = conn.execute(query, params)

        rows = []
        for row in cursor:
            row_dict = {}
            for key in row.keys():
                val = row[key]
                if isinstance(val, bytes):
                    import base64
                    row_dict[key] = {"__bytes__": base64.b64encode(val).decode('ascii')}
                else:
                    row_dict[key] = val
            rows.append(row_dict)

        conn.close()
        print(json.dumps(rows))

    finally:
        if tmp_dir:
            try:
                shutil.rmtree(tmp_dir)
            except OSError:
                pass

if __name__ == '__main__':
    main()
