# E-Learn Backend (Python / Flask + SQLite)

This is a Python version of the E-Learn backend, exposing the **exact
same API** as the Node.js version in `../elearning-backend`, so the
frontend's `Script.js` works with either one unchanged.

**Ready to put this on a real server?** See **[DEPLOYMENT.md](./DEPLOYMENT.md)**
for a full walkthrough (VPS + HTTPS, or PythonAnywhere) and a
pre-launch security checklist. Everything below is about local development.

## Requirements

- Python 3.9+
- Flask (the only dependency — SQLite is built into Python, no separate
  database server needed)

## Setup & run

```
pip install -r requirements.txt
python app.py
```

You should see:

```
E-Learn backend (Python / SQLite) running at http://localhost:3000
Database file: .../data/e-learn.db
Sessions last 30.0 days and survive server restarts.
```

Set a different port with the `PORT` environment variable:

```
PORT=4000 python app.py
```

## Where your data lives

- **`data/e-learn.db`** — a real SQLite database file. Contains everyone's
  accounts, courses, curriculum, and enrollments. Back it up by copying
  this one file.
- **`data/secret.key`** — a random signing key, generated automatically on
  first run. **Keep this private** — anyone who has it could forge valid
  login tokens for any account. Don't commit it to git, don't share it.
  Deleting it invalidates every existing login session (everyone has to
  log in again), but does NOT delete any accounts or data.

## Sessions survive restarts

Unlike a typical simple demo backend, login sessions here are **signed
tokens** (HMAC-SHA256), not an in-memory list — so restarting the server
does **not** log anyone out. A session naturally expires after 30 days
(override with the `SESSION_DAYS` environment variable), or immediately
when someone clicks "Log out" (which explicitly revokes that token).

```
SESSION_DAYS=7 python app.py
```

## Course content (what students actually read)

Courses are organized under three suggested categories — **School**,
**College**, **University** — but the Admin Panel's "+ Add new category"
option lets you type any custom category too (e.g. "Engineering Entrance",
"Coaching Classes"). Custom categories automatically show up as their own
filter tag on the Courses page.

Each module can have an actual file attached — **PDF, PPT/PPTX, DOC/DOCX,
or TXT**, up to 100 MB — uploaded directly through the Admin Panel (or you
can paste a link to a file already hosted elsewhere instead). Uploaded
files are stored in `data/uploads/` and served at `/uploads/<filename>`;
only enrolled students (or staff) can see the download link, same as the
rest of a module's content.

When adding a course from the Admin Panel, each module can have:

- **Lesson content** — the actual text students read (explanation, steps,
  examples). Plain text, shown as-is on the learning page.
- **A resource link** (optional) — a label + URL, e.g. a PDF, a video, or
  an external article. Shown as a clickable button under the lesson.

This content is **locked**: `course-detail.html` (the public page anyone
can see) only shows module *titles* — like a syllabus. The full lesson
text and resource link only unlock on `learn.html?id=<course-id>`, and
only for:

- a learner who has enrolled in that specific course, or
- an Admin / Super Admin (so staff can preview content without enrolling)

Everyone else gets redirected with a clear message telling them to enroll
first.

Admin/Super Admin can **edit** any existing course (including ones they
didn't originally create) from the Admin Panel — click **Edit** next to a
course in the list, change anything (including individual module content
and resource links), and save. The course keeps the same URL/id even if
the title changes, so existing enrollments and links stay valid.

## Profile editing & photos

Every logged-in user (Student, Admin, or Super Admin) can click **Edit
Profile** on their profile page to change their display name and upload
a profile photo. Photos are resized to 200×200 in the browser before
upload (via canvas), so the backend never receives huge files — stored
as a base64 image string on the user record, capped at ~300KB.

## Connecting the frontend

The frontend's `Script.js` expects the backend at `http://localhost:3000/api`
by default. If you run this Python backend instead of the Node one, keep it
on port 3000 (or update the `API_BASE` constant near the top of
`Script.js`).

Only run **one** backend at a time — they can't both bind to the same port.

**CORS is restricted to a specific list of frontend origins** — by default
`http://localhost:5500` / `http://127.0.0.1:5500` (VS Code "Live Server"
defaults) plus a couple of other common dev ports. If your frontend runs
somewhere else, set `ALLOWED_ORIGINS` before starting:

```
ALLOWED_ORIGINS="http://localhost:5500,http://127.0.0.1:5500" python app.py
```

## Roles & Admin Panel

Every account has one of three roles:

| Role | Can do |
|---|---|
| **Student** (default) | Browse courses, enroll, view own profile |
| **Admin** | Everything a Student can, plus add/delete courses |
| **Super Admin** | Everything an Admin can, plus change anyone's role from the Admin Panel |

**No configuration needed** — the very first account ever created on a
fresh database automatically becomes Super Admin. Everyone who signs up
after that starts as a Student.

To give someone Admin or Super Admin access: log in as the Super Admin,
go to **Admin Panel → User Management**, and change their role from a
dropdown. It takes effect the next time they load a page — no server
restart needed.

The "Admin Panel" link only appears in the site's navigation for
Admin/Super Admin accounts. Students who try to open `admin.html` directly
see an access-denied message instead of the form.

## API reference

Identical to the Node backend — see `../elearning-backend/README.md` for
the full endpoint table. Quick summary:

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup` | – | Create an account → `{ token, user }` (first-ever account becomes `superadmin`) |
| POST | `/api/auth/login` | – | Log in → `{ token, user }` |
| POST | `/api/auth/logout` | Bearer token | Invalidate the session |
| GET | `/api/me` | Bearer token | Current learner + enrollments (`user.role`, `user.isStaff`, `user.isSuperAdmin`) |
| GET | `/api/courses` | – | Full course catalog (curriculum shows module *titles only*) |
| GET | `/api/courses/:id` | – | Single course (curriculum shows module *titles only*) |
| GET | `/api/courses/:id/content` | Bearer token (enrolled learner or Admin/Super Admin) | Full curriculum with lesson content + resource links |
| POST | `/api/courses` | Bearer token (Admin/Super Admin) | Add a new course → `{ course }` (curriculum items can include `content`, `resourceLabel`, `resourceUrl`) |
| PUT | `/api/courses/:id` | Bearer token (Admin/Super Admin) | Edit an existing course (same id preserved) → `{ course }` |
| POST | `/api/me/update` | Bearer token | Update your own name and/or photo → `{ user }` |
| DELETE | `/api/courses/:id` | Bearer token (Admin/Super Admin) | Remove a course |
| POST | `/api/courses/:id/enroll` | Bearer token | Enroll in a course |
| GET | `/api/admin/users` | Bearer token (Super Admin only) | List every user and their role |
| POST | `/api/admin/users/:id/role` | Bearer token (Super Admin only) | Change a user's role → `{ role: "student" \| "admin" \| "superadmin" }` |
| GET | `/api/health` | – | `{ ok: true }` |

## Implementation notes

- Passwords are hashed with Werkzeug's `generate_password_hash` /
  `check_password_hash` (PBKDF2 under the hood) — never stored in plain text.
- Sessions are **signed tokens** (HMAC-SHA256), verified without a
  database lookup, and **survive server restarts** — see above.
- Users, courses, curriculum, and enrollments are stored in a real SQLite
  database (`data/e-learn.db`), not a flat JSON file.
- All XSS-sensitive output (course titles, descriptions, lesson content,
  user names shown in the Admin Panel) is HTML-escaped on the frontend
  before insertion into the page.
- Resource links (module URLs) are restricted to `http://`/`https://` —
  `javascript:` and other schemes are stripped server-side.
- Profile photos are validated with a strict regex — only base64
  JPEG/PNG data URIs are accepted (SVG is rejected, since it can embed
  scripts).
- CORS is restricted to the `ALLOWED_ORIGINS` list described above, rather
  than allowing every origin.
- Rate limiting has two tiers: `/api/auth/*` is capped at 10 requests/min
  per IP (brute-force protection), and the whole API is capped at
  120 requests/min per IP (general abuse protection).
- Error messages for signup/login are deliberately generic (they don't
  confirm whether an email is already registered, or which of email/
  password was wrong on a failed login).
- Every response includes `X-Content-Type-Options`, `X-Frame-Options`, and
  `Referrer-Policy` headers.
- Flask's built-in dev server is used here for simplicity. For production,
  run behind a real WSGI server (gunicorn, uWSGI) instead of `python app.py`.

## Known limitations (this is still a demo/learning backend)

- **No HTTPS** — this server speaks plain HTTP. Anyone on the same network
  could intercept tokens/passwords in transit. Put this behind a reverse
  proxy (nginx, Caddy) with a real TLS certificate before exposing it
  beyond your own machine — Caddy in particular can get you free
  auto-renewing HTTPS with about 2 lines of config.
- No email verification or password reset flow.
- Rate limiting is in-memory/per-process — restarting the server or
  running multiple instances resets/splits the counters. Fine for one
  small deployment, not for a load-balanced cluster.
- SQLite handles moderate traffic well, but for serious concurrent load
  you'd eventually want Postgres/MySQL instead.

None of this is unusual for a learning project — just know what you're
signing up for if you put this on the open internet as-is.