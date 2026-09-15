# E-Learn

A notes-sharing platform for school, college, and university students.
Browse notes by category, enroll in a course, and read/download the
actual lesson content (PDF, PPT, DOC, TXT) once enrolled. Admins can add,
edit, and manage courses from a built-in Admin Panel — no separate CMS
needed.

## Project structure

This repo has two independent parts that talk to each other over a
simple REST API:

```
.
├── elearning-site/            → Frontend: plain HTML, CSS, JavaScript
│   ├── index.html, courses.html, admin.html, ... (all pages)
│   ├── style.css               (all styling)
│   └── Script.js                (all frontend logic — talks to the backend API)
│
└── elearning-backend-python/  → Backend: Python (Flask) + SQLite
    ├── app.py                  (the entire API server)
    ├── requirements.txt
    ├── README.md                → backend-specific setup & API reference
    ├── DEPLOYMENT.md             → putting this on a real server (VPS, HTTPS, nginx)
    ├── ORACLE_SETUP.md           → step-by-step for Oracle Cloud's free tier
    └── data/                     → created automatically (database, uploads, secret key)
```

There's no build step, no framework, no bundler — the frontend is opened
directly in a browser (or served as static files), and it calls the
backend's API for everything dynamic: accounts, courses, enrollments,
file uploads.

## How frontend and backend connect

`elearning-site/script.js` has one line that decides where the backend
lives:

```js
var API_BASE = (function () {
  var host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/api';
  }
  return '/api';
})();
```

- **On your own computer** (localhost/127.0.0.1): it talks to the backend
  directly on port 3000. This is what you get running both parts locally.
- **On a real domain**: it uses a relative `/api` path instead, assuming
  your web server (nginx, etc.) forwards `/api/...` requests to the Flask
  app behind the scenes — see `elearning-backend-python/DEPLOYMENT.md` for
  exactly how to set that up. This way frontend and backend share one
  domain in production and there's no CORS to fight with.

## Quick start (local development)

You need two terminals open at once.

**Terminal 1 — backend:**
```bash
cd elearning-backend-python
pip install -r requirements.txt
python app.py
```
Leave this running. You should see:
```
E-Learn backend (Python / SQLite) running at http://localhost:3000
```

**Terminal 2 — frontend:**
```bash
cd elearning-site
python3 -m http.server 5500
```
Then open **http://localhost:5500** in your browser.

(If you use VS Code, the "Live Server" extension works too — just make
sure the backend from Terminal 1 is running first.)

The **first account you sign up with automatically becomes Super Admin** —
no config file, no environment variable. From there you can promote other
accounts to Admin or Super Admin from the Admin Panel's User Management
section.

## Features

- Student / Admin / Super Admin roles, with the first signup auto-promoted
- Course catalog organized by category (School / College / University, or
  any custom category an Admin types in)
- Each course has modules with real lesson content — not just a title
- File attachments per module: PDF, PPT/PPTX, DOC/DOCX, TXT (up to 100 MB)
- Course content is gated: only enrolled students (or staff) can see the
  full lesson text and download links — everyone else sees just the
  module titles, like a syllabus
- Profile editing with a photo upload (auto-resized in the browser)
- Signed, stateless login sessions that survive server restarts
- Security: HTML-escaping everywhere user content is displayed, restricted
  file-upload types, path-traversal-safe file serving, rate limiting,
  CORS locked to known origins, and a full security checklist in
  `DEPLOYMENT.md`

## Deploying this for real

See **[`elearning-backend-python/DEPLOYMENT.md`](./elearning-backend-python/DEPLOYMENT.md)**
for a complete walkthrough: a small VPS with nginx + free HTTPS
(Let's Encrypt), a security checklist to run through before going live,
and backup guidance. If you're using Oracle Cloud's free tier specifically,
start with **[`ORACLE_SETUP.md`](./elearning-backend-python/ORACLE_SETUP.md)** instead.

## Tech stack

- **Frontend:** plain HTML5, CSS3, vanilla JavaScript — no framework, no
  build tools, no dependencies to install
- **Backend:** Python 3, Flask, SQLite (built into Python) — the only pip
  dependency is Flask itself (plus gunicorn for production)

## License

Add whatever license fits your use of this project (MIT is a common,
permissive choice) — there isn't one included by default.
