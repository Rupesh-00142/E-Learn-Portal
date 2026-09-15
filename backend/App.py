"""
E-Learn backend — Python / Flask version, backed by SQLite.

Run:
    pip install -r requirements.txt
    python app.py

Port 3000 by default (override with the PORT environment variable).

Data is stored in ./data/e-learn.db (a real SQLite database file,
created automatically on first run — no separate database server needed,
sqlite3 is built into Python).

--- Sessions survive restarts ---
Login tokens are signed (HMAC-SHA256) rather than looked up in an
in-memory dict, so restarting the server does NOT log everyone out —
only an explicit logout, or the token's expiry (30 days by default,
override with SESSION_DAYS), invalidates a token. The signing secret is
generated once and saved to ./data/secret.key; keep that file private —
anyone with it could forge valid login tokens.

--- Roles ---
Every account has a role: "student", "admin", or "superadmin".

- student   : default role. Can browse/enroll in courses, has a profile.
- admin     : everything a student can do, PLUS can add/edit/remove courses.
- superadmin: everything an admin can do, PLUS can promote/demote other
              users' roles from the Admin Panel.

The very FIRST account ever created on a fresh database automatically
becomes "superadmin" — no config file or environment variable needed.
From then on, that superadmin manages everyone else's role from the
website's Admin Panel (User Management section).
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, request, g, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB — matches MAX_UPLOAD_SIZE below

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.expanduser("~"), ".elearn-data")
DB_PATH = os.path.join(DATA_DIR, "e-learn.db")
SECRET_KEY_PATH = os.path.join(DATA_DIR, "secret.key")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")

# What file types can be uploaded as note attachments, and how big.
ALLOWED_UPLOAD_EXTENSIONS = {
    "pdf": "application/pdf",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain",
}
MAX_UPLOAD_SIZE = 100 * 1024 * 1024  # 100 MB

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
# These three are the quick-pick options shown in the admin form, but
# admins can also type a custom category — see validate_category() below.
SUGGESTED_CATEGORIES = {"school", "college", "university"}
CATEGORY_RE = re.compile(r"^[a-z0-9][a-z0-9 \-]{0,48}[a-z0-9]$|^[a-z0-9]$")


def validate_category(raw):
    """Accepts the suggested categories AND any reasonable custom one the
    admin types — just needs to be non-empty, short, and made of plain
    letters/numbers/spaces/hyphens (keeps it safe to use in URLs/filters)."""
    cat = str(raw or "").strip().lower()[:50]
    if not cat or not CATEGORY_RE.match(cat):
        return None
    return cat
VALID_LEVELS = {"Beginner", "Intermediate", "Advanced"}
VALID_ROLES = {"student", "admin", "superadmin"}
# Strict: only valid base64 JPEG/PNG data URIs — the base64 charset itself
# (A-Z a-z 0-9 + / =) contains no quote or angle-bracket characters, so a
# string matching this can never break out of an HTML attribute.
PHOTO_DATA_URI_RE = re.compile(r"^data:image/(png|jpe?g);base64,[A-Za-z0-9+/]+=*$")

SESSION_DAYS = float(os.environ.get("SESSION_DAYS", "30"))

# Which frontend origins are allowed to call this API.
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,"
        "http://localhost:5501,http://127.0.0.1:5501,"
        "http://localhost:8080,http://127.0.0.1:8080",
    ).split(",") if o.strip()
]

# ---------- signing secret (persisted so tokens survive restarts) ----------

def load_or_create_secret():
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(SECRET_KEY_PATH, 0o600)  # owner read/write only — not on Windows, that's fine
    except OSError:
        pass
    return key


SECRET_KEY = load_or_create_secret().encode("utf-8")

# ---------- very basic rate limiting (per IP) ----------
AUTH_RATE_LIMIT_WINDOW_SECONDS = 60
AUTH_RATE_LIMIT_MAX = 10          # tight limit — this is where brute-forcing happens
GENERAL_RATE_LIMIT_WINDOW_SECONDS = 60
GENERAL_RATE_LIMIT_MAX = 120      # looser limit — just to stop spam/abuse across the whole API
auth_rate_buckets = {}
general_rate_buckets = {}


def _is_limited(buckets, ip, window, limit):
    now = time.time()
    timestamps = [t for t in buckets.get(ip, []) if now - t < window]
    timestamps.append(now)
    buckets[ip] = timestamps
    return len(timestamps) > limit


def is_auth_rate_limited(ip):
    return _is_limited(auth_rate_buckets, ip, AUTH_RATE_LIMIT_WINDOW_SECONDS, AUTH_RATE_LIMIT_MAX)


def is_general_rate_limited(ip):
    return _is_limited(general_rate_buckets, ip, GENERAL_RATE_LIMIT_WINDOW_SECONDS, GENERAL_RATE_LIMIT_MAX)


def get_client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


# ---------- SQLite setup ----------

# This starts empty on purpose — a notes site should start with real
# content the admin adds, not generic placeholder courses. Add your own
# from the Admin Panel once the site is running (categories: school,
# college, university).
SEED_COURSES = []


def get_conn():
    if "db_conn" not in g:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db_conn = conn
    return g.db_conn


@app.teardown_appcontext
def close_conn(_exc):
    conn = g.pop("db_conn", None)
    if conn is not None:
        conn.close()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            photo TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS courses (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            level TEXT NOT NULL,
            price REAL NOT NULL,
            description TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS curriculum (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            resource_label TEXT NOT NULL DEFAULT '',
            resource_url TEXT NOT NULL DEFAULT '',
            resources_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS enrollments (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            progress INTEGER NOT NULL DEFAULT 0,
            time_spent_seconds INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, course_id)
        );

        CREATE TABLE IF NOT EXISTS revoked_tokens (
            signature TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
        );
    """)

    # Migration: older databases created before time-tracking existed won't
    # have this column yet — add it if missing (safe to run every startup).
    existing_cols = [r[1] for r in conn.execute("PRAGMA table_info(enrollments)").fetchall()]
    if "time_spent_seconds" not in existing_cols:
        conn.execute("ALTER TABLE enrollments ADD COLUMN time_spent_seconds INTEGER NOT NULL DEFAULT 0")

    existing_curr_cols = [r[1] for r in conn.execute("PRAGMA table_info(curriculum)").fetchall()]
    if "resources_json" not in existing_curr_cols:
        conn.execute("ALTER TABLE curriculum ADD COLUMN resources_json TEXT NOT NULL DEFAULT '[]'")
        # Backfill: modules saved before multi-file support had one
        # resource_label/resource_url pair each — carry that into the new
        # resources array so existing courses don't lose their attachment.
        old_rows = conn.execute("SELECT id, resource_label, resource_url FROM curriculum").fetchall()
        for r in old_rows:
            if r[2]:
                conn.execute(
                    "UPDATE curriculum SET resources_json = ? WHERE id = ?",
                    (json.dumps([{"label": r[1] or "Resource", "url": r[2]}]), r[0]),
                )

    course_count = conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0]
    if course_count == 0:
        for c in SEED_COURSES:
            conn.execute(
                "INSERT INTO courses (id, title, category, level, price, description) VALUES (?, ?, ?, ?, ?, ?)",
                (c["id"], c["title"], c["category"], c["level"], c["price"], c["description"]),
            )
            for i, mod_title in enumerate(c["curriculum"]):
                conn.execute(
                    "INSERT INTO curriculum (course_id, position, title) VALUES (?, ?, ?)",
                    (c["id"], i, mod_title),
                )
    conn.commit()
    conn.close()


init_db()


# ---------- session tokens (stateless, signed — survive restarts) ----------

def create_token(user_id):
    expires_at = int(time.time() + SESSION_DAYS * 86400)
    payload = f"{user_id}.{expires_at}"
    signature = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def verify_token(token):
    """Returns the user_id if the token is valid, unexpired, and not
    revoked — otherwise None."""
    try:
        user_id, expires_at_str, signature = token.split(".")
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return None

    payload = f"{user_id}.{expires_at_str}"
    expected_signature = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        return None
    if expires_at < time.time():
        return None

    conn = get_conn()
    revoked = conn.execute("SELECT 1 FROM revoked_tokens WHERE signature = ?", (signature,)).fetchone()
    if revoked:
        return None

    return user_id


def revoke_token(token):
    try:
        _user_id, expires_at_str, signature = token.split(".")
        expires_at = int(expires_at_str)
    except (ValueError, AttributeError):
        return
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO revoked_tokens (signature, expires_at) VALUES (?, ?)", (signature, expires_at))
    # Opportunistic cleanup of old revoked entries so this table doesn't grow forever.
    conn.execute("DELETE FROM revoked_tokens WHERE expires_at < ?", (int(time.time()),))
    conn.commit()


# ---------- data access helpers (shape-compatible with the old JSON version) ----------

def row_to_user_dict(row):
    if row is None:
        return None
    conn = get_conn()
    enrollment_rows = conn.execute(
        "SELECT course_id, progress, time_spent_seconds FROM enrollments WHERE user_id = ?", (row["id"],)
    ).fetchall()
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "passwordHash": row["password_hash"],
        "createdAt": row["created_at"],
        "role": row["role"],
        "photo": row["photo"],
        "enrollments": [
            {"courseId": e["course_id"], "progress": e["progress"], "timeSpentSeconds": e["time_spent_seconds"]}
            for e in enrollment_rows
        ],
    }


def find_user_by_email(email):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return row_to_user_dict(row)


def find_user_by_id(user_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return row_to_user_dict(row)


def count_users():
    conn = get_conn()
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def count_superadmins(exclude_id=None):
    conn = get_conn()
    if exclude_id:
        return conn.execute(
            "SELECT COUNT(*) FROM users WHERE role = 'superadmin' AND id != ?", (exclude_id,)
        ).fetchone()[0]
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'superadmin'").fetchone()[0]


def insert_user(user):
    conn = get_conn()
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, created_at, role, photo) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user["id"], user["name"], user["email"], user["passwordHash"], user["createdAt"], user["role"], user.get("photo", "")),
    )
    conn.commit()


def update_user_fields(user_id, **fields):
    if not fields:
        return
    conn = get_conn()
    columns = {"name": "name", "photo": "photo", "role": "role"}
    sets = []
    values = []
    for key, value in fields.items():
        col = columns.get(key)
        if not col:
            continue
        sets.append(f"{col} = ?")
        values.append(value)
    if not sets:
        return
    values.append(user_id)
    conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", values)
    conn.commit()


def list_all_users():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM users ORDER BY created_at ASC").fetchall()
    return [row_to_user_dict(r) for r in rows]


def add_enrollment(user_id, course_id):
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO enrollments (user_id, course_id, progress) VALUES (?, ?, 0)",
        (user_id, course_id),
    )
    conn.commit()


def find_course(course_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
    if not row:
        return None
    mod_rows = conn.execute(
        "SELECT title, content, resources_json FROM curriculum WHERE course_id = ? ORDER BY position ASC",
        (course_id,),
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "category": row["category"],
        "level": row["level"],
        "price": row["price"],
        "description": row["description"],
        "curriculum": [
            {"title": m["title"], "content": m["content"], "resources": json.loads(m["resources_json"] or "[]")}
            for m in mod_rows
        ],
    }


def list_all_courses():
    conn = get_conn()
    rows = conn.execute("SELECT id FROM courses ORDER BY rowid ASC").fetchall()
    return [find_course(r["id"]) for r in rows]


def insert_course(course):
    conn = get_conn()
    conn.execute(
        "INSERT INTO courses (id, title, category, level, price, description) VALUES (?, ?, ?, ?, ?, ?)",
        (course["id"], course["title"], course["category"], course["level"], course["price"], course["description"]),
    )
    _replace_curriculum(course["id"], course["curriculum"])
    conn.commit()


def update_course_row(course_id, fields):
    conn = get_conn()
    conn.execute(
        "UPDATE courses SET title = ?, category = ?, level = ?, price = ?, description = ? WHERE id = ?",
        (fields["title"], fields["category"], fields["level"], fields["price"], fields["description"], course_id),
    )
    _replace_curriculum(course_id, fields["curriculum"])
    conn.commit()


def _replace_curriculum(course_id, curriculum):
    conn = get_conn()
    conn.execute("DELETE FROM curriculum WHERE course_id = ?", (course_id,))
    for i, m in enumerate(curriculum):
        conn.execute(
            "INSERT INTO curriculum (course_id, position, title, content, resources_json) VALUES (?, ?, ?, ?, ?)",
            (course_id, i, m["title"], m["content"], json.dumps(m["resources"])),
        )


def delete_course_row(course_id):
    conn = get_conn()
    conn.execute("DELETE FROM courses WHERE id = ?", (course_id,))  # cascades to curriculum + enrollments
    conn.commit()


def existing_course_ids():
    conn = get_conn()
    return {r["id"] for r in conn.execute("SELECT id FROM courses").fetchall()}


# ---------- business-logic helpers (unchanged shape from the JSON version) ----------

def is_enrolled(user, course_id):
    return any(e["courseId"] == course_id for e in user.get("enrollments", []))


def is_staff(user):
    """admin or superadmin — can manage courses."""
    return bool(user) and user.get("role") in ("admin", "superadmin")


def is_superadmin(user):
    """superadmin only — can manage other users' roles."""
    return bool(user) and user.get("role") == "superadmin"


def public_user(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "createdAt": user["createdAt"],
        "role": user.get("role", "student"),
        "photo": user.get("photo", ""),
        "isAdmin": is_staff(user),         # kept for backwards compatibility
        "isStaff": is_staff(user),
        "isSuperAdmin": is_superadmin(user),
    }


def get_user_from_request():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer "):]
    user_id = verify_token(token)
    if not user_id:
        return None
    return find_user_by_id(user_id)


def is_valid_email(email):
    return bool(EMAIL_RE.match(email)) and len(email) <= 254


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower().strip()).strip("-")
    return (slug[:60] or "course")


def unique_slug(base):
    slug = base
    n = 2
    existing_ids = existing_course_ids()
    while slug in existing_ids:
        slug = f"{base}-{n}"
        n += 1
    return slug


def sanitize_resource_url(url):
    """Only allow http/https links, or a path to a file uploaded through
    this app's own /api/upload endpoint (starts with /uploads/). Blocks
    'javascript:' and other schemes that could execute code if someone
    clicks the resource link."""
    url = str(url or "").strip()[:500]
    if url.lower().startswith(("http://", "https://")):
        return url
    if re.match(r"^/uploads/[a-zA-Z0-9._-]+$", url):
        return url
    return ""


def public_curriculum(curriculum):
    """What anyone (even not logged in) can see: just module titles —
    like a syllabus. No lesson content or resource links."""
    return [{"title": m["title"]} for m in (curriculum or [])]


def full_curriculum(curriculum):
    """Full module content + resource links — only for enrolled students
    or staff, via the protected /content endpoint."""
    return curriculum or []


@app.after_request
def add_security_headers(response):
    origin = request.headers.get("Origin")
    if origin and origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    # This API only ever returns JSON — a strict CSP here costs nothing
    # and blocks this origin from ever being used to serve/execute HTML/JS,
    # even by accident or via a future bug.
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    # Only matters once you're actually serving over HTTPS (see DEPLOYMENT.md) —
    # harmless to send over plain HTTP in local development.
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def handle_options(_any):
    return "", 204


@app.before_request
def enforce_rate_limits():
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return
    ip = get_client_ip()
    if request.path.startswith("/api/auth/"):
        if is_auth_rate_limited(ip):
            return jsonify({"error": "Too many attempts. Please wait a minute and try again."}), 429
    if is_general_rate_limited(ip):
        return jsonify({"error": "Too many requests. Please slow down."}), 429


# ---------- auth routes ----------

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/api/auth/signup", methods=["POST"])
def signup():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()[:100]
    email = (body.get("email") or "").strip().lower()[:254]
    password = body.get("password") or ""

    if not name or not email or not password:
        return jsonify({"error": "Name, email, and password are all required."}), 400
    if not is_valid_email(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(password) < 6 or len(password) > 200:
        return jsonify({"error": "Password must be between 6 and 200 characters."}), 400
    if find_user_by_email(email):
        return jsonify({"error": "Could not create account with those details."}), 409

    # The very first account on a fresh database becomes the superadmin.
    role = "superadmin" if count_users() == 0 else "student"

    user = {
        "id": str(uuid.uuid4()),
        "name": name,
        "email": email,
        "passwordHash": generate_password_hash(password),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "photo": "",
    }
    insert_user(user)
    user["enrollments"] = []

    token = create_token(user["id"])
    return jsonify({"token": token, "user": public_user(user)}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()[:254]
    password = body.get("password") or ""

    user = find_user_by_email(email)
    if not user or not check_password_hash(user["passwordHash"], password):
        return jsonify({"error": "Incorrect email or password."}), 401

    token = create_token(user["id"])
    return jsonify({"token": token, "user": public_user(user)})


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        revoke_token(auth[len("Bearer "):])
    return jsonify({"ok": True})


@app.route("/api/me", methods=["GET"])
def me():
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "Not logged in."}), 401

    enrollments = []
    for e in user.get("enrollments", []):
        course = find_course(e["courseId"])
        enrollments.append({
            "courseId": e["courseId"],
            "title": course["title"] if course else e["courseId"],
            "category": course["category"] if course else None,
            "progress": e["progress"],
            "timeSpentSeconds": e.get("timeSpentSeconds", 0),
        })

    return jsonify({"user": public_user(user), "enrollments": enrollments})


@app.route("/api/me/update", methods=["POST"])
def update_me():
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "Not logged in."}), 401

    body = request.get_json(silent=True) or {}
    updates = {}

    if "name" in body:
        name = (body.get("name") or "").strip()[:100]
        if not name:
            return jsonify({"error": "Name cannot be empty."}), 400
        updates["name"] = name

    if "photo" in body:
        photo = body.get("photo") or ""
        if photo:
            if not PHOTO_DATA_URI_RE.match(photo):
                return jsonify({"error": "Photo must be a JPEG or PNG image."}), 400
            if len(photo) > 400000:  # roughly ~300KB decoded — client resizes before sending
                return jsonify({"error": "Photo is too large. Try a smaller image."}), 400
            updates["photo"] = photo
        else:
            updates["photo"] = ""  # empty string clears the photo

    if updates:
        update_user_fields(user["id"], **updates)
        user = find_user_by_id(user["id"])

    return jsonify({"user": public_user(user)})


# ---------- file uploads (PDF/PPT/DOC/TXT notes attachments) ----------

@app.route("/api/upload", methods=["POST"])
def upload_file():
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_staff(user):
        return jsonify({"error": "Admin access required."}), 403

    if "file" not in request.files:
        return jsonify({"error": "No file was sent."}), 400

    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "No file was selected."}), 400

    original_name = f.filename
    ext = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        return jsonify({
            "error": f"File type not allowed. Allowed types: {', '.join(sorted(ALLOWED_UPLOAD_EXTENSIONS))}."
        }), 400

    # Read into memory once so we can check the real size (Content-Length
    # headers can lie) and reject anything over the limit before writing
    # anything to disk.
    contents = f.read()
    if len(contents) > MAX_UPLOAD_SIZE:
        return jsonify({"error": "File is too large. Maximum size is 100 MB."}), 400
    if len(contents) == 0:
        return jsonify({"error": "That file is empty."}), 400

    os.makedirs(UPLOADS_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(UPLOADS_DIR, stored_name), "wb") as out:
        out.write(contents)

    return jsonify({
        "url": f"/uploads/{stored_name}",
        "label": original_name[:150],
    }), 201


@app.route("/uploads/<path:filename>", methods=["GET"])
def serve_upload(filename):
    # send_from_directory refuses paths that try to escape UPLOADS_DIR
    # (e.g. "../../app.py"), so this can't be used to read arbitrary files.
    return send_from_directory(UPLOADS_DIR, filename, as_attachment=False)


# ---------- course routes ----------

@app.route("/api/courses", methods=["GET"])
def list_courses():
    public_courses = []
    for c in list_all_courses():
        pc = dict(c)
        pc["curriculum"] = public_curriculum(c.get("curriculum"))
        public_courses.append(pc)
    return jsonify({"courses": public_courses})


@app.route("/api/courses/<course_id>", methods=["GET"])
def get_course(course_id):
    course = find_course(course_id)
    if not course:
        return jsonify({"error": "Course not found."}), 404
    public_course = dict(course)
    public_course["curriculum"] = public_curriculum(course.get("curriculum"))
    return jsonify({"course": public_course})


@app.route("/api/courses/<course_id>/content", methods=["GET"])
def get_course_content(course_id):
    """Full lesson content + resource links. Only for students who are
    enrolled in this specific course, or staff (admin/superadmin)."""
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401

    course = find_course(course_id)
    if not course:
        return jsonify({"error": "Course not found."}), 404

    if not is_enrolled(user, course_id) and not is_staff(user):
        return jsonify({"error": "Enroll in this course to access its content."}), 403

    full_course = dict(course)
    full_course["curriculum"] = full_curriculum(course.get("curriculum"))
    return jsonify({"course": full_course})


def parse_course_body(body):
    """Shared validation for both creating and editing a course.
    Returns (fields_dict, error_message). fields_dict is None if invalid."""
    title = (body.get("title") or "").strip()[:150]
    category = validate_category(body.get("category"))
    level = (body.get("level") or "").strip()
    price = body.get("price")
    description = (body.get("description") or "").strip()[:2000]
    curriculum_raw = body.get("curriculum") or []
    if not isinstance(curriculum_raw, list):
        curriculum_raw = []

    curriculum = []
    for item in curriculum_raw[:40]:
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            continue
        mod_title = str(item.get("title", "")).strip()[:150]
        if not mod_title:
            continue

        resources_raw = item.get("resources") or []
        if not isinstance(resources_raw, list):
            resources_raw = []
        resources = []
        for res in resources_raw[:10]:  # cap at 10 files/links per module
            if not isinstance(res, dict):
                continue
            url = sanitize_resource_url(res.get("url", ""))
            if not url:
                continue
            resources.append({"label": str(res.get("label", "")).strip()[:150], "url": url})

        curriculum.append({
            "title": mod_title,
            "content": str(item.get("content", "")).strip()[:5000],
            "resources": resources,
        })

    if not title:
        return None, "Course title is required."
    if category is None:
        return None, "Please choose or type a category (letters, numbers, spaces, and hyphens only, no more than 50 characters)."
    if level not in VALID_LEVELS:
        return None, f"Level must be one of: {', '.join(VALID_LEVELS)}."
    try:
        price = float(price)
        if price < 0 or price > 100000:
            raise ValueError()
    except (TypeError, ValueError):
        return None, "Price must be a valid, non-negative number."

    return {
        "title": title,
        "category": category,
        "level": level,
        "price": price,
        "description": description,
        "curriculum": curriculum,
    }, None


@app.route("/api/courses", methods=["POST"])
def create_course():
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_staff(user):
        return jsonify({"error": "Admin access required."}), 403

    body = request.get_json(silent=True) or {}
    fields, error = parse_course_body(body)
    if error:
        return jsonify({"error": error}), 400

    course = {"id": unique_slug(slugify(fields["title"]))}
    course.update(fields)
    insert_course(course)

    return jsonify({"course": course}), 201


@app.route("/api/courses/<course_id>", methods=["PUT"])
def update_course(course_id):
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_staff(user):
        return jsonify({"error": "Admin access required."}), 403

    course = find_course(course_id)
    if not course:
        return jsonify({"error": "Course not found."}), 404

    body = request.get_json(silent=True) or {}
    fields, error = parse_course_body(body)
    if error:
        return jsonify({"error": error}), 400

    # Keep the same id (and therefore the same URL and existing
    # enrollments) even if the title changes.
    update_course_row(course_id, fields)
    course.update(fields)

    return jsonify({"course": course})


@app.route("/api/courses/<course_id>", methods=["DELETE"])
def delete_course(course_id):
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_staff(user):
        return jsonify({"error": "Admin access required."}), 403

    course = find_course(course_id)
    if not course:
        return jsonify({"error": "Course not found."}), 404

    delete_course_row(course_id)

    return jsonify({"ok": True})


@app.route("/api/courses/<course_id>/track-time", methods=["POST"])
def track_time(course_id):
    """Called every ~30s by the Learn page while a student has a course
    open, so we can build up real 'time spent' totals. Only counts time
    for courses the student is actually enrolled in, and clamps the
    per-call amount so a tampered request can't inflate the total."""
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401

    if not is_enrolled(user, course_id):
        return jsonify({"error": "You're not enrolled in this course."}), 403

    body = request.get_json(silent=True) or {}
    try:
        seconds = int(body.get("seconds", 0))
    except (TypeError, ValueError):
        seconds = 0
    seconds = max(0, min(seconds, 60))

    conn = get_conn()
    conn.execute(
        "UPDATE enrollments SET time_spent_seconds = time_spent_seconds + ? WHERE user_id = ? AND course_id = ?",
        (seconds, user["id"], course_id),
    )
    conn.commit()
    return jsonify({"ok": True})


@app.route("/api/courses/<course_id>/enroll", methods=["POST"])
def enroll(course_id):
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401

    course = find_course(course_id)
    if not course:
        return jsonify({"error": "Course not found."}), 404

    add_enrollment(user["id"], course_id)
    user = find_user_by_id(user["id"])

    return jsonify({"ok": True, "enrollments": user["enrollments"]})


# ---------- admin: user management (superadmin only) ----------

@app.route("/api/admin/users", methods=["GET"])
def list_users():
    user = get_user_from_request()
    if not user:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_superadmin(user):
        return jsonify({"error": "Super Admin access required."}), 403

    users = [
        {
            "id": u["id"],
            "name": u["name"],
            "email": u["email"],
            "role": u.get("role", "student"),
            "createdAt": u["createdAt"],
        }
        for u in list_all_users()
    ]
    return jsonify({"users": users})


@app.route("/api/admin/users/<user_id>/role", methods=["POST"])
def change_user_role(user_id):
    actor = get_user_from_request()
    if not actor:
        return jsonify({"error": "You need to log in first."}), 401
    if not is_superadmin(actor):
        return jsonify({"error": "Super Admin access required."}), 403

    body = request.get_json(silent=True) or {}
    new_role = (body.get("role") or "").strip().lower()
    if new_role not in VALID_ROLES:
        return jsonify({"error": f"Role must be one of: {', '.join(sorted(VALID_ROLES))}."}), 400

    target = find_user_by_id(user_id)
    if not target:
        return jsonify({"error": "User not found."}), 404

    # Don't allow removing the last superadmin — someone has to be able to
    # manage the site.
    if target.get("role") == "superadmin" and new_role != "superadmin":
        if count_superadmins(exclude_id=user_id) == 0:
            return jsonify({"error": "Cannot remove the only Super Admin. Promote someone else first."}), 400

    update_user_fields(user_id, role=new_role)

    return jsonify({"ok": True, "user": {"id": target["id"], "role": new_role}})


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "Not found."}), 404


@app.errorhandler(500)
def server_error(_e):
    return jsonify({"error": "Something went wrong on the server."}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"E-Learn backend (Python / SQLite) running at http://localhost:{port}")
    print(f"Database file: {DB_PATH}")
    print(f"Allowed frontend origins: {', '.join(ALLOWED_ORIGINS)}")
    print(f"Sessions last {SESSION_DAYS} days and survive server restarts.")
    with app.app_context():
        existing_superadmins = [u["email"] for u in list_all_users() if u.get("role") == "superadmin"]
    if existing_superadmins:
        print(f"Existing Super Admin(s): {', '.join(existing_superadmins)}")
    else:
        print("No Super Admin yet — the FIRST account that signs up will automatically become one.")
    app.run(host="0.0.0.0", port=port)