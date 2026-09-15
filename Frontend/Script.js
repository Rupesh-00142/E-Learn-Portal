/* ===== Security helpers =====
   Anything a user typed (course titles, descriptions, names, lesson
   content, etc.) must be escaped before going into innerHTML — otherwise
   someone could store a script tag as their name/course text and have it
   execute in another user's (including an admin's) browser. */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http/https links — blocks "javascript:" URLs and similar
// schemes that could execute code when someone clicks a resource link.
// Only allow http/https links, or a file uploaded through this app's own
// /api/upload (those are served by the BACKEND, not the frontend server,
// so a bare "/uploads/xxx.pdf" needs the backend's own origin stitched on
// in front of it — otherwise the browser would look for it on the
// frontend's server instead and get a 404).
function safeUrl(url) {
  if (!url) return '';
  var trimmed = String(url).trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.indexOf('/uploads/') === 0) {
    var backendOrigin = API_BASE.replace(/\/api$/, '');
    return backendOrigin + trimmed;
  }
  return '';
}

/* ===== Backend connection =====
   Local development (opened on localhost/127.0.0.1): talks to the backend
   directly on port 3000, same as before.
   Production (a real domain): uses a same-origin "/api" path instead —
   the deployment setup (see DEPLOYMENT.md) has nginx serve this frontend
   AND forward "/api/..." to the Flask backend, so both live under one
   domain and there's no cross-origin request at all (no CORS needed).
   If you deploy the frontend and backend on two different domains
   instead, change API_BASE below to the backend's full URL. */
var API_BASE = (function () {
  var host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:3000/api';
  }
  return '/api';
})();

/* ===== Auth token storage (just the token — no fake user data) ===== */
function getToken() {
  return localStorage.getItem('e-learn_token');
}
function setToken(token) {
  localStorage.setItem('e-learn_token', token);
}
function clearToken() {
  localStorage.removeItem('e-learn_token');
}

/* ===== Small fetch helper ===== */
function api(path, options) {
  options = options || {};
  var headers = options.headers || {};
  headers['Content-Type'] = 'application/json';
  var token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  return fetch(API_BASE + path, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).catch(function () {
    // fetch() itself throws (not the .then chain) when the server can't be
    // reached at all — wrong port, backend not started, CORS blocked, etc.
    throw new Error('Could not reach the backend at ' + API_BASE + '. Make sure the server is running (see the backend README).');
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var err = new Error(data.error || 'Something went wrong.');
        err.status = res.status;
        throw err;
      }
      return data;
    });
  });
}

function logoutUser() {
  api('/auth/logout', { method: 'POST' }).catch(function () {
    /* ignore network errors on logout, we're clearing the token anyway */
  }).then(function () {
    clearToken();
    window.location.href = 'index.html';
  });
}

function renderNavAuthState() {
  var navActions = document.getElementById('navActions');
  if (!navActions || !getToken()) return;

  api('/me').then(function (data) {
    var adminLink = data.user.isStaff
      ? '<a href="admin.html" class="btn btn-outline">Admin Panel</a>'
      : '';
    navActions.innerHTML =
      adminLink +
      '<a href="profile.html" class="btn btn-outline">' + escapeHtml(data.user.name.split(' ')[0]) + '\u2019s Profile</a>' +
      '<button type="button" class="btn btn-primary" id="logoutBtn">Log out</button>';
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);
  }).catch(function () {
    // Token is invalid or the backend isn't reachable — treat as logged out.
    clearToken();
  });
}

function showFormError(form, message) {
  var existing = form.querySelector('.form-error');
  if (existing) existing.remove();
  var el = document.createElement('p');
  el.className = 'form-error';
  el.style.cssText = 'color:#DC2626; font-size:13px; margin:-8px 0 16px;';
  el.textContent = message;
  form.insertBefore(el, form.firstChild);
}

document.addEventListener('DOMContentLoaded', function () {
  renderNavAuthState();

  var toggle = document.getElementById('menuToggle');
  var menu = document.getElementById('navMenu');
  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      menu.classList.toggle('open');
    });
  }

  // Signup form
  var signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = document.getElementById('fullname').value.trim();
      var email = document.getElementById('email').value.trim();
      var password = document.getElementById('password').value;
      var confirm = document.getElementById('confirm-password').value;
      var agreeTerms = document.getElementById('agreeTerms');

      if (!name || !email || !password) {
        showFormError(signupForm, 'Please fill in all fields.');
        return;
      }
      if (password !== confirm) {
        showFormError(signupForm, 'Passwords do not match.');
        return;
      }
      if (agreeTerms && !agreeTerms.checked) {
        showFormError(signupForm, 'Please agree to the Terms & Privacy Policy to continue.');
        return;
      }

      var submitBtn = signupForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating account...';

      api('/auth/signup', { method: 'POST', body: { name: name, email: email, password: password } })
        .then(function (data) {
          setToken(data.token);
          window.location.href = 'profile.html';
        })
        .catch(function (err) {
          showFormError(signupForm, err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Account';
        });
    });
  }

  // Login form
  var loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value.trim();
      var password = document.getElementById('password').value;

      if (!email || !password) {
        showFormError(loginForm, 'Please enter your email and password.');
        return;
      }

      var submitBtn = loginForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging in...';

      api('/auth/login', { method: 'POST', body: { email: email, password: password } })
        .then(function (data) {
          setToken(data.token);
          window.location.href = 'profile.html';
        })
        .catch(function (err) {
          showFormError(loginForm, err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Log In';
        });
    });
  }

  // Profile page: fetch real learner data from the backend
  var profileName = document.getElementById('profileName');
  if (profileName) {
    if (!getToken()) {
      window.location.href = 'login.html';
    } else {
      api('/me').then(function (data) {
        renderProfileHeader(data.user);
        renderProfileCourses(data.enrollments);
        renderProfileStats(data.enrollments);
        initEditProfile(data.user);
      }).catch(function () {
        clearToken();
        window.location.href = 'login.html';
      });
    }
  }

  // Logout button on profile page
  var logoutBtnStandalone = document.getElementById('logoutBtnProfile');
  if (logoutBtnStandalone) {
    logoutBtnStandalone.addEventListener('click', logoutUser);
  }

  // Enroll button on course-detail.html
  var enrollBtn = document.getElementById('enrollBtn');
  if (enrollBtn) {
    enrollBtn.addEventListener('click', function (e) {
      // Already enrolled — this button now just navigates to the lessons,
      // no need to call the enroll API again.
      if (enrollBtn.textContent.indexOf('Continue Learning') !== -1) {
        return;
      }
      e.preventDefault();
      if (!getToken()) {
        window.location.href = 'login.html';
        return;
      }
      var courseId = enrollBtn.getAttribute('data-course-id');
      enrollBtn.textContent = 'Enrolling...';
      api('/courses/' + courseId + '/enroll', { method: 'POST' })
        .then(function () {
          enrollBtn.textContent = 'Continue Learning \u2192';
          enrollBtn.href = 'learn.html?id=' + encodeURIComponent(courseId);
        })
        .catch(function (err) {
          alert(err.message);
          enrollBtn.textContent = 'Enroll Now';
        });
    });
  }

  // Courses page: load courses dynamically from the backend
  var coursesGrid = document.getElementById('coursesGrid');
  if (coursesGrid) {
    initCoursesPage(coursesGrid);
  }

  // Home page: live category counts
  var homeCategoriesGrid = document.getElementById('homeCategoriesGrid');
  if (homeCategoriesGrid) {
    initHomeCategories();
  }

  var featuredCoursesGrid = document.getElementById('featuredCoursesGrid');
  if (featuredCoursesGrid) {
    initFeaturedCourses(featuredCoursesGrid);
  }

  // Course detail page: load a single course by ?id= from the backend
  var courseContent = document.getElementById('courseContent');
  if (courseContent) {
    initCourseDetailPage();
  }

  // Learn page: full lesson content for enrolled students
  var learnContent = document.getElementById('learnContent');
  if (learnContent) {
    initLearnPage();
  }

  // Admin page
  var adminContent = document.getElementById('adminContent');
  if (adminContent) {
    initAdminPage();
  }
});

function renderProfileHeader(user) {
  document.getElementById('profileName').textContent = user.name;
  document.getElementById('profileEmail').textContent = user.email;
  setAvatarContent(document.getElementById('profileInitial'), user);
}

function setAvatarContent(el, user) {
  if (user.photo) {
    el.innerHTML = '<img src="' + escapeHtml(user.photo) + '" alt="Profile photo">';
  } else {
    el.textContent = user.name.charAt(0).toUpperCase();
  }
}

function resizeImageFile(file, maxSize, callback) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      var ctx = canvas.getContext('2d');
      // Cover-crop: scale so the shorter side fills maxSize, then center-crop.
      var scale = Math.max(maxSize / img.width, maxSize / img.height);
      var w = img.width * scale;
      var h = img.height * scale;
      var x = (maxSize - w) / 2;
      var y = (maxSize - h) / 2;
      ctx.drawImage(img, x, y, w, h);
      callback(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function initEditProfile(user) {
  var editBtn = document.getElementById('editProfileBtn');
  var section = document.getElementById('editProfileSection');
  var cancelBtn = document.getElementById('cancelEditProfileBtn');
  var form = document.getElementById('editProfileForm');
  var nameInput = document.getElementById('editName');
  var photoInput = document.getElementById('photoInput');
  var photoPreview = document.getElementById('photoPreview');
  var pendingPhoto = null; // null = no change; '' = cleared; data URI = new photo

  if (!editBtn) return;

  function openEditForm() {
    nameInput.value = user.name;
    pendingPhoto = null;
    setAvatarContent(photoPreview, user);
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  editBtn.addEventListener('click', openEditForm);
  cancelBtn.addEventListener('click', function () {
    section.style.display = 'none';
  });

  photoInput.addEventListener('change', function () {
    var file = photoInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file.');
      return;
    }
    resizeImageFile(file, 200, function (dataUri) {
      pendingPhoto = dataUri;
      photoPreview.innerHTML = '<img src="' + dataUri + '" alt="New profile photo">';
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    if (!name) {
      showFormError(form, 'Name cannot be empty.');
      return;
    }

    var body = { name: name };
    if (pendingPhoto !== null) body.photo = pendingPhoto;

    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    api('/me/update', { method: 'POST', body: body })
      .then(function (data) {
        user = data.user;
        renderProfileHeader(user);
        renderNavAuthState();
        section.style.display = 'none';
      })
      .catch(function (err) {
        showFormError(form, err.message);
      })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Changes';
      });
  });
}

function formatDuration(totalSeconds) {
  var totalMinutes = Math.floor(totalSeconds / 60);
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  if (hours === 0 && minutes === 0) return '0m';
  if (hours === 0) return minutes + 'm';
  if (minutes === 0) return hours + 'h';
  return hours + 'h ' + minutes + 'm';
}

function renderProfileStats(enrollments) {
  var inProgress = enrollments.filter(function (e) { return e.progress < 100; }).length;
  var completed = enrollments.filter(function (e) { return e.progress >= 100; }).length;
  var totalSeconds = enrollments.reduce(function (sum, e) { return sum + (e.timeSpentSeconds || 0); }, 0);
  var statEls = document.querySelectorAll('.profile-stat-card strong');
  if (statEls.length >= 3) {
    statEls[0].textContent = inProgress;
    statEls[1].textContent = completed;
    statEls[2].textContent = formatDuration(totalSeconds);
  }
}

function renderProfileCourses(enrollments) {
  var list = document.getElementById('profileCourseList');
  if (!list) return;

  if (!enrollments.length) {
    list.innerHTML = '<p style="color:var(--text-light); font-size:14px;">' +
      "You haven't enrolled in any courses yet. " +
      '<a href="courses.html" style="color:var(--primary); font-weight:600;">Browse courses</a> to get started.</p>';
    return;
  }

  list.innerHTML = enrollments.map(function (e) {
    var label = e.progress >= 100 ? 'Completed &middot; Certificate earned' : e.progress + '% complete';
    var action = e.progress >= 100 ? 'Review' : 'Continue';
    var safeTitle = escapeHtml(e.title);
    return (
      '<div class="profile-course-row">' +
        '<div class="course-thumb" style="width:90px; height:60px; border-radius:6px; font-size:11px;">' + safeTitle + '</div>' +
        '<div class="profile-course-info">' +
          '<h4>' + safeTitle + '</h4>' +
          '<div class="progress-bar"><div class="progress-fill" style="width:' + e.progress + '%;"></div></div>' +
          '<span class="progress-label">' + label + '</span>' +
        '</div>' +
        '<a href="learn.html?id=' + encodeURIComponent(e.courseId) + '" class="btn btn-outline">' + action + '</a>' +
      '</div>'
    );
  }).join('');
}

/* ===== Courses page (dynamic, loaded from backend) ===== */

var CATEGORY_LABELS = { school: 'School', college: 'College', university: 'University' };

function initHomeCategories() {
  api('/courses').then(function (data) {
    var counts = { school: 0, college: 0, university: 0 };
    data.courses.forEach(function (c) {
      if (counts.hasOwnProperty(c.category)) counts[c.category]++;
    });
    function label(n) { return n === 1 ? '1 set of notes' : n + ' sets of notes'; }
    document.getElementById('countSchool').textContent = label(counts.school);
    document.getElementById('countCollege').textContent = label(counts.college);
    document.getElementById('countUniversity').textContent = label(counts.university);
  }).catch(function () {
    ['countSchool', 'countCollege', 'countUniversity'].forEach(function (id) {
      document.getElementById(id).textContent = 'Browse notes';
    });
  });
}

function initFeaturedCourses(grid) {
  api('/courses').then(function (data) {
    var recent = data.courses.slice(-4).reverse(); // last 4 added, newest first
    if (!recent.length) {
      grid.innerHTML = '<p style="color:var(--text-light); text-align:center; grid-column:1/-1;">No notes added yet. Check back soon!</p>';
      return;
    }
    grid.innerHTML = recent.map(function (c) {
      var label = categoryLabel(c.category);
      return (
        '<a href="course-detail.html?id=' + encodeURIComponent(c.id) + '" class="course-card">' +
          '<div class="course-thumb">' + escapeHtml(label) + '</div>' +
          '<div class="course-body">' +
            '<span class="course-tag">' + escapeHtml(c.level) + '</span>' +
            '<h3>' + escapeHtml(c.title) + '</h3>' +
            (c.description ? '<p class="desc">' + escapeHtml(c.description) + '</p>' : '') +
            '<div class="course-meta">' +
              '<span>' + escapeHtml(label) + '</span>' +
              '<span class="course-price">$' + c.price + '</span>' +
            '</div>' +
          '</div>' +
        '</a>'
      );
    }).join('');
  }).catch(function () {
    grid.innerHTML = '<p style="color:var(--text-light); text-align:center; grid-column:1/-1;">Could not load notes right now.</p>';
  });
}

function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
}

function initCoursesPage(grid) {
  var allCourses = [];
  var filterTagsContainer = document.getElementById('filterTags');

  function renderCourses(courses) {
    if (!courses.length) {
      grid.innerHTML = '<p style="color:var(--text-light);">No courses in this category yet.</p>';
      return;
    }
    grid.innerHTML = courses.map(function (c) {
      var label = categoryLabel(c.category);
      return (
        '<a href="course-detail.html?id=' + encodeURIComponent(c.id) + '" class="course-card" data-category="' + c.category + '">' +
          '<div class="course-thumb">' + escapeHtml(label) + '</div>' +
          '<div class="course-body">' +
            '<span class="course-tag">' + escapeHtml(c.level) + '</span>' +
            '<h3>' + escapeHtml(c.title) + '</h3>' +
            (c.description ? '<p class="desc">' + escapeHtml(c.description) + '</p>' : '') +
            '<div class="course-meta">' +
              '<span>' + escapeHtml(label) + '</span>' +
              '<span class="course-price">$' + c.price + '</span>' +
            '</div>' +
          '</div>' +
        '</a>'
      );
    }).join('');
  }

  function wireFilterClicks() {
    var filterTags = filterTagsContainer.querySelectorAll('.filter-tag');
    filterTags.forEach(function (tag) {
      tag.addEventListener('click', function () {
        filterTags.forEach(function (t) { t.classList.remove('active'); });
        tag.classList.add('active');
        var filter = tag.getAttribute('data-filter');
        var filtered = filter === 'all' ? allCourses : allCourses.filter(function (c) { return c.category === filter; });
        renderCourses(filtered);
      });
    });
  }

  api('/courses').then(function (data) {
    allCourses = data.courses;

    // Build filter buttons from whatever categories are actually in use —
    // this naturally includes any custom category an admin has added.
    var seen = {};
    var categories = [];
    allCourses.forEach(function (c) {
      if (!seen[c.category]) {
        seen[c.category] = true;
        categories.push(c.category);
      }
    });
    // Show the three common ones first (even if empty), then any custom ones found.
    var ordered = ['school', 'college', 'university'].filter(function (c) { return seen[c]; })
      .concat(categories.filter(function (c) { return ['school', 'college', 'university'].indexOf(c) === -1; }));

    ordered.forEach(function (cat) {
      var btn = document.createElement('button');
      btn.className = 'filter-tag';
      btn.setAttribute('data-filter', cat);
      btn.textContent = categoryLabel(cat);
      filterTagsContainer.appendChild(btn);
    });

    var presetCategory = new URLSearchParams(window.location.search).get('category');
    var filterTags = filterTagsContainer.querySelectorAll('.filter-tag');

    if (presetCategory) {
      filterTags.forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-filter') === presetCategory);
      });
      renderCourses(allCourses.filter(function (c) { return c.category === presetCategory; }));
    } else {
      renderCourses(allCourses);
    }

    wireFilterClicks();
  }).catch(function (err) {
    grid.innerHTML = '<p style="color:#DC2626;">Could not load courses: ' + err.message + '</p>';
  });
}

/* ===== Course detail page (dynamic, loaded from backend by ?id=) ===== */

function initCourseDetailPage() {
  var loadingEl = document.getElementById('courseLoading');
  var notFoundEl = document.getElementById('courseNotFound');
  var contentEl = document.getElementById('courseContent');

  var params = new URLSearchParams(window.location.search);
  var courseId = params.get('id');

  if (!courseId) {
    loadingEl.style.display = 'none';
    notFoundEl.style.display = 'block';
    return;
  }

  api('/courses/' + encodeURIComponent(courseId)).then(function (data) {
    var c = data.course;
    var catLabel = categoryLabel(c.category);

    document.getElementById('pageTitle').textContent = c.title + ' - E-Learn';
    document.getElementById('crumbTitle').textContent = c.title;
    document.getElementById('courseTagLine').textContent = catLabel + ' \u00B7 ' + c.level;
    document.getElementById('courseTitle').textContent = c.title;
    document.getElementById('courseDescTop').textContent = c.description || '';
    document.getElementById('courseDescFull').textContent = c.description || 'No description provided for this course yet.';
    document.getElementById('sidebarPrice').textContent = '$' + c.price;
    document.getElementById('sidebarCategory').textContent = catLabel;
    document.getElementById('sidebarLevel').textContent = c.level;
    document.getElementById('sidebarModules').textContent = (c.curriculum || []).length;

    var curriculumList = document.getElementById('curriculumList');
    if (c.curriculum && c.curriculum.length) {
      curriculumList.innerHTML = c.curriculum.map(function (item, i) {
        return (
          '<div class="curriculum-item">' +
            '<div class="curriculum-head"><span>' + (i + 1) + '. ' + escapeHtml(item.title) + '</span></div>' +
          '</div>'
        );
      }).join('');
    } else {
      curriculumList.innerHTML = '<p style="color:var(--text-light); font-size:14px;">No curriculum has been added for this course yet.</p>';
    }

    var enrollBtn = document.getElementById('enrollBtn');
    enrollBtn.setAttribute('data-course-id', c.id);

    // If the learner is already logged in and already enrolled, send them
    // straight to the content instead of showing "Enroll Now" again.
    if (getToken()) {
      api('/me').then(function (meData) {
        var already = (meData.enrollments || []).some(function (e) { return e.courseId === c.id; });
        if (already) {
          enrollBtn.textContent = 'Continue Learning \u2192';
          enrollBtn.href = 'learn.html?id=' + encodeURIComponent(c.id);
        }
      }).catch(function () { /* not a big deal if this check fails */ });
    }

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
  }).catch(function () {
    loadingEl.style.display = 'none';
    notFoundEl.style.display = 'block';
  });
}

/* Sends a heartbeat to the backend every 30s while the student has this
   course's Learn page open and the tab is actually visible, so "time
   spent" reflects real attention rather than an idle background tab. */
function startTimeTracking(courseId) {
  var HEARTBEAT_SECONDS = 30;
  var timerId = setInterval(function () {
    if (document.hidden) return;
    api('/courses/' + encodeURIComponent(courseId) + '/track-time', {
      method: 'POST',
      body: { seconds: HEARTBEAT_SECONDS }
    }).catch(function () { /* best-effort — don't interrupt the lesson over this */ });
  }, HEARTBEAT_SECONDS * 1000);

  window.addEventListener('beforeunload', function () {
    clearInterval(timerId);
  });
}

/* ===== Learn page (full lesson content, enrolled students only) ===== */

function initLearnPage() {
  var loadingEl = document.getElementById('learnLoading');
  var blockedEl = document.getElementById('learnBlocked');
  var contentEl = document.getElementById('learnContent');
  var blockedTitle = document.getElementById('blockedTitle');
  var blockedText = document.getElementById('blockedText');
  var blockedLink = document.getElementById('blockedLink');

  var params = new URLSearchParams(window.location.search);
  var courseId = params.get('id');

  function showBlocked(title, text, linkHref, linkLabel) {
    loadingEl.style.display = 'none';
    blockedEl.style.display = 'block';
    blockedTitle.textContent = title;
    blockedText.textContent = text;
    blockedLink.href = linkHref;
    blockedLink.textContent = linkLabel;
  }

  if (!courseId) {
    showBlocked('Course not found', 'No course was specified.', 'courses.html', 'Browse Courses');
    return;
  }

  if (!getToken()) {
    showBlocked('Log in to continue', 'You need to be logged in and enrolled to view this course.', 'login.html', 'Log In');
    return;
  }

  api('/courses/' + encodeURIComponent(courseId) + '/content').then(function (data) {
    var c = data.course;
    document.getElementById('pageTitle').textContent = c.title + ' - Learn - E-Learn';
    document.getElementById('crumbTitle').textContent = c.title;
    document.getElementById('courseTitle').textContent = c.title;

    var modules = c.curriculum || [];
    var moduleNav = document.getElementById('moduleNav');
    var lessonPane = document.getElementById('lessonPane');

    if (!modules.length) {
      moduleNav.innerHTML = '<p style="padding:0 20px; font-size:13px; color:var(--text-light);">No modules yet.</p>';
      lessonPane.innerHTML = '<p style="color:var(--text-light);">This course does not have any content yet. Check back later.</p>';
      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';
      return;
    }

    function renderModule(index) {
      var m = modules[index];
      document.querySelectorAll('.module-nav-item').forEach(function (el, i) {
        el.classList.toggle('active', i === index);
      });
      var resources = m.resources && m.resources.length
        ? m.resources
        : (m.resourceUrl ? [{ label: m.resourceLabel, url: m.resourceUrl }] : []);
      var resourceHtml = resources.map(function (r) {
        var cleanUrl = safeUrl(r.url);
        if (!cleanUrl) return '';
        return '<a href="' + escapeHtml(cleanUrl) + '" target="_blank" rel="noopener noreferrer" class="lesson-resource">\uD83D\uDD17 ' +
          escapeHtml(r.label || 'Open Resource') + '</a>';
      }).join('');
      lessonPane.innerHTML =
        '<h2>' + (index + 1) + '. ' + escapeHtml(m.title) + '</h2>' +
        '<div class="lesson-content">' + (m.content ? escapeHtml(m.content) : 'No lesson content has been added for this module yet.') + '</div>' +
        resourceHtml;
    }

    moduleNav.innerHTML = modules.map(function (m, i) {
      return '<button type="button" class="module-nav-item" data-index="' + i + '"><span class="num">' + (i + 1) + '.</span> ' + escapeHtml(m.title) + '</button>';
    }).join('');

    moduleNav.querySelectorAll('.module-nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        renderModule(Number(btn.getAttribute('data-index')));
      });
    });

    renderModule(0);
    startTimeTracking(courseId);

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
  }).catch(function (err) {
    if (err.status === 403) {
      showBlocked('Enroll to unlock this course', 'You need to enroll in this course before you can view its lessons.', 'course-detail.html?id=' + encodeURIComponent(courseId), 'Go to Course Page');
    } else if (err.status === 404) {
      showBlocked('Course not found', 'This course may have been removed.', 'courses.html', 'Browse Courses');
    } else if (err.status === 401) {
      showBlocked('Log in to continue', 'Your session has expired. Please log in again.', 'login.html', 'Log In');
    } else {
      showBlocked('Something went wrong', err.message, 'courses.html', 'Browse Courses');
    }
  });
}

/* ===== Admin page ===== */

var ROLE_LABELS = { student: 'Student', admin: 'Admin', superadmin: 'Super Admin' };

function initAdminPage() {
  if (!getToken()) {
    window.location.href = 'login.html';
    return;
  }

  var gate = document.getElementById('adminGate');
  var content = document.getElementById('adminContent');
  var listEl = document.getElementById('adminCourseList');
  var form = document.getElementById('addCourseForm');
  var roleBadgeText = document.getElementById('roleBadgeText');
  var userSection = document.getElementById('userManagementSection');
  var userListEl = document.getElementById('userList');
  var moduleBuilder = document.getElementById('moduleBuilder');
  var addModuleBtn = document.getElementById('addModuleBtn');
  var moduleCount = 0;
  var editingCourseId = null;
  var formHeading = document.getElementById('courseFormHeading');
  var submitBtn2 = document.getElementById('courseFormSubmitBtn');
  var cancelEditBtn = document.getElementById('cancelEditBtn');
  var categorySelect = document.getElementById('courseCategory');
  var customCategoryInput = document.getElementById('customCategoryInput');

  categorySelect.addEventListener('change', function () {
    if (categorySelect.value === '__custom__') {
      customCategoryInput.style.display = 'block';
      customCategoryInput.focus();
    } else {
      customCategoryInput.style.display = 'none';
      customCategoryInput.value = '';
    }
  });

  function getSelectedCategory() {
    if (categorySelect.value === '__custom__') {
      return customCategoryInput.value.trim().toLowerCase();
    }
    return categorySelect.value;
  }

  function setCategoryValue(category) {
    var isKnown = ['school', 'college', 'university'].indexOf(category) !== -1;
    if (isKnown) {
      categorySelect.value = category;
      customCategoryInput.style.display = 'none';
      customCategoryInput.value = '';
    } else if (category) {
      categorySelect.value = '__custom__';
      customCategoryInput.style.display = 'block';
      customCategoryInput.value = category;
    } else {
      categorySelect.value = '';
      customCategoryInput.style.display = 'none';
      customCategoryInput.value = '';
    }
  }

  function resetFormToAddMode() {
    editingCourseId = null;
    form.reset();
    setCategoryValue('');
    moduleBuilder.innerHTML = '';
    addModuleBlock();
    formHeading.textContent = 'Add a New Course';
    submitBtn2.textContent = 'Add Course';
    cancelEditBtn.style.display = 'none';
  }

  cancelEditBtn.addEventListener('click', resetFormToAddMode);

  function loadCourseIntoFormForEdit(courseId) {
    api('/courses/' + encodeURIComponent(courseId) + '/content').then(function (data) {
      var c = data.course;
      editingCourseId = c.id;

      document.getElementById('courseTitle').value = c.title;
      setCategoryValue(c.category);
      document.getElementById('courseLevel').value = c.level;
      document.getElementById('coursePrice').value = c.price;
      document.getElementById('courseDescription').value = c.description || '';

      moduleBuilder.innerHTML = '';
      if (c.curriculum && c.curriculum.length) {
        c.curriculum.forEach(function (m) {
          addModuleBlock(m);
        });
      } else {
        addModuleBlock();
      }

      formHeading.textContent = 'Edit Course: ' + c.title;
      submitBtn2.textContent = 'Update Course';
      cancelEditBtn.style.display = 'block';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) {
      alert('Could not load course for editing: ' + err.message);
    });
  }

  function addModuleBlock(prefill) {
    prefill = prefill || {};
    moduleCount++;
    var block = document.createElement('div');
    block.className = 'module-block';
    block.innerHTML =
      '<div class="module-block-head">' +
        '<span>Module</span>' +
        '<button type="button" class="module-remove-btn">Remove</button>' +
      '</div>' +
      '<label>Module Title</label>' +
      '<input type="text" class="module-title" placeholder="e.g. Getting Started">' +
      '<label>Lesson Content (what students will read)</label>' +
      '<textarea class="module-content" rows="4" placeholder="Write the actual lesson text here — explanation, steps, examples..."></textarea>' +
      '<label>Files & Resources</label>' +
      '<div class="module-resources"></div>' +
      '<button type="button" class="module-add-resource-btn btn btn-outline" style="margin-top:2px; margin-bottom:16px;">+ Add Another File</button>';
    block.querySelector('.module-title').value = prefill.title || '';
    block.querySelector('.module-content').value = prefill.content || '';

    var resourcesEl = block.querySelector('.module-resources');

    function addResourceRow(prefillResource) {
      prefillResource = prefillResource || {};
      var item = document.createElement('div');
      item.className = 'module-resource-item';
      item.style.cssText = 'border:1px solid var(--border); border-radius:var(--radius); padding:14px; margin-bottom:10px;';
      item.innerHTML =
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">' +
          '<strong style="font-size:13px;">File</strong>' +
          '<button type="button" class="module-resource-remove-btn btn btn-outline" style="padding:4px 10px; font-size:12px;">Remove</button>' +
        '</div>' +
        '<label>Attach a file (PDF, PPT, DOC, or TXT — up to 100 MB)</label>' +
        '<input type="file" class="module-file-input" accept=".pdf,.ppt,.pptx,.doc,.docx,.txt">' +
        '<p class="module-upload-status" style="font-size:12px; color:var(--text-light); margin:-4px 0 8px;">No file attached yet.</p>' +
        '<p style="font-size:12px; color:var(--text-light); margin:0 0 6px;">— or link to a file that\'s already online instead —</p>' +
        '<div class="module-resource-row">' +
          '<div><label>Resource Label (optional)</label><input type="text" class="module-resource-label" placeholder="e.g. Slides PDF"></div>' +
          '<div><label>Resource URL (optional)</label><input type="url" class="module-resource-url" placeholder="https://..."></div>' +
        '</div>';

      item.querySelector('.module-resource-label').value = prefillResource.label || '';
      item.querySelector('.module-resource-url').value = prefillResource.url || '';

      var statusEl = item.querySelector('.module-upload-status');
      if (prefillResource.url && prefillResource.url.indexOf('/uploads/') === 0) {
        statusEl.textContent = 'Attached: ' + (prefillResource.label || prefillResource.url);
        statusEl.style.color = 'var(--success)';
      }

      item.querySelector('.module-file-input').addEventListener('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;

        if (file.size > 100 * 1024 * 1024) {
          statusEl.textContent = 'That file is too large (max 100 MB).';
          statusEl.style.color = '#DC2626';
          e.target.value = '';
          return;
        }

        statusEl.textContent = 'Uploading ' + file.name + '...';
        statusEl.style.color = 'var(--text-light)';

        var formData = new FormData();
        formData.append('file', file);

        fetch(API_BASE + '/upload', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + getToken() },
          body: formData
        })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.data.error || 'Upload failed.');
            item.querySelector('.module-resource-url').value = result.data.url;
            var labelInput = item.querySelector('.module-resource-label');
            if (!labelInput.value.trim()) labelInput.value = result.data.label;
            statusEl.textContent = 'Attached: ' + result.data.label;
            statusEl.style.color = 'var(--success)';
          })
          .catch(function (err) {
            statusEl.textContent = 'Upload failed: ' + err.message;
            statusEl.style.color = '#DC2626';
            e.target.value = '';
          });
      });

      item.querySelector('.module-resource-remove-btn').addEventListener('click', function () {
        item.remove();
      });

      resourcesEl.appendChild(item);
    }

    // Accept either the new "resources" array, or fall back to reading an
    // older single resourceLabel/resourceUrl pair from data saved before
    // multi-file support existed.
    var existingResources = prefill.resources && prefill.resources.length
      ? prefill.resources
      : (prefill.resourceUrl ? [{ label: prefill.resourceLabel, url: prefill.resourceUrl }] : []);

    if (existingResources.length) {
      existingResources.forEach(function (r) { addResourceRow(r); });
    } else {
      addResourceRow();
    }

    block.querySelector('.module-add-resource-btn').addEventListener('click', function () {
      addResourceRow();
    });

    block.querySelector('.module-remove-btn').addEventListener('click', function () {
      block.remove();
    });
    moduleBuilder.appendChild(block);
  }

  addModuleBtn.addEventListener('click', addModuleBlock);
  addModuleBlock(); // start with one empty module ready to fill in

  function collectModules() {
    var blocks = moduleBuilder.querySelectorAll('.module-block');
    var modules = [];
    blocks.forEach(function (block) {
      var title = block.querySelector('.module-title').value.trim();
      if (!title) return; // skip empty/unfilled module blocks
      var resources = [];
      block.querySelectorAll('.module-resource-item').forEach(function (item) {
        var label = item.querySelector('.module-resource-label').value.trim();
        var url = item.querySelector('.module-resource-url').value.trim();
        if (label || url) resources.push({ label: label, url: url });
      });
      modules.push({
        title: title,
        content: block.querySelector('.module-content').value.trim(),
        resources: resources
      });
    });
    return modules;
  }

  function loadCourseList() {
    api('/courses').then(function (data) {
      if (!data.courses.length) {
        listEl.innerHTML = '<p style="color:var(--text-light); font-size:14px;">No courses yet.</p>';
        return;
      }
      listEl.innerHTML = data.courses.map(function (c) {
        return (
          '<div class="profile-course-row">' +
            '<div class="profile-course-info">' +
              '<h4 style="margin-bottom:4px;">' + escapeHtml(c.title) + '</h4>' +
              '<span style="font-size:12px; color:var(--text-light);">' +
                escapeHtml(categoryLabel(c.category)) + ' &middot; ' + escapeHtml(c.level) + ' &middot; $' + c.price +
              '</span>' +
            '</div>' +
            '<button type="button" class="btn btn-outline edit-course-btn" data-course-id="' + c.id + '" style="margin-right:8px;">Edit</button>' +
            '<button type="button" class="btn btn-outline delete-course-btn" data-course-id="' + c.id + '">Delete</button>' +
          '</div>'
        );
      }).join('');

      listEl.querySelectorAll('.edit-course-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          loadCourseIntoFormForEdit(btn.getAttribute('data-course-id'));
        });
      });

      listEl.querySelectorAll('.delete-course-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!confirm('Delete this course? This cannot be undone.')) return;
          var courseId = btn.getAttribute('data-course-id');
          api('/courses/' + courseId, { method: 'DELETE' })
            .then(function () { loadCourseList(); })
            .catch(function (err) { alert(err.message); });
        });
      });
    }).catch(function (err) {
      listEl.innerHTML = '<p style="color:#DC2626;">Could not load courses: ' + err.message + '</p>';
    });
  }

  function loadUserList(currentUserId) {
    api('/admin/users').then(function (data) {
      if (!data.users.length) {
        userListEl.innerHTML = '<p style="color:var(--text-light); font-size:14px;">No users yet.</p>';
        return;
      }
      userListEl.innerHTML = data.users.map(function (u) {
        var isSelf = u.id === currentUserId;
        return (
          '<div class="profile-course-row user-row">' +
            '<div class="profile-course-info">' +
              '<h4 style="margin-bottom:4px;">' + escapeHtml(u.name) + (isSelf ? ' <span style="color:var(--text-light); font-weight:400;">(you)</span>' : '') + '</h4>' +
              '<span style="font-size:12px; color:var(--text-light);">' + escapeHtml(u.email) + '</span>' +
            '</div>' +
            '<span class="role-badge ' + u.role + '">' + ROLE_LABELS[u.role] + '</span>' +
            '<select class="role-select" data-user-id="' + u.id + '" ' + (isSelf ? 'disabled title="You cannot change your own role"' : '') + '>' +
              '<option value="student"' + (u.role === 'student' ? ' selected' : '') + '>Student</option>' +
              '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>Admin</option>' +
              '<option value="superadmin"' + (u.role === 'superadmin' ? ' selected' : '') + '>Super Admin</option>' +
            '</select>' +
          '</div>'
        );
      }).join('');

      userListEl.querySelectorAll('.role-select').forEach(function (select) {
        select.addEventListener('change', function () {
          var userId = select.getAttribute('data-user-id');
          var newRole = select.value;
          select.disabled = true;
          api('/admin/users/' + userId + '/role', { method: 'POST', body: { role: newRole } })
            .then(function () {
              loadUserList(currentUserId);
            })
            .catch(function (err) {
              alert(err.message);
              loadUserList(currentUserId);
            });
        });
      });
    }).catch(function (err) {
      userListEl.innerHTML = '<p style="color:#DC2626;">Could not load users: ' + err.message + '</p>';
    });
  }

  api('/me').then(function (data) {
    if (!data.user.isStaff) {
      gate.style.display = 'block';
      return;
    }
    content.style.display = 'block';
    roleBadgeText.innerHTML = 'You are signed in as <span class="role-badge ' + data.user.role + '">' + ROLE_LABELS[data.user.role] + '</span>';
    loadCourseList();

    if (data.user.isSuperAdmin) {
      userSection.style.display = 'block';
      loadUserList(data.user.id);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = document.getElementById('courseTitle').value.trim();
      var category = getSelectedCategory();
      var level = document.getElementById('courseLevel').value;
      var price = document.getElementById('coursePrice').value;
      var description = document.getElementById('courseDescription').value.trim();
      var curriculum = collectModules();

      if (categorySelect.value === '__custom__' && !customCategoryInput.value.trim()) {
        showFormError(form, 'Please type a name for the new category.');
        return;
      }
      if (!title || !category || !level || price === '') {
        showFormError(form, 'Please fill in all fields.');
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = editingCourseId ? 'Updating...' : 'Adding...';

      var body = { title: title, category: category, level: level, price: Number(price), description: description, curriculum: curriculum };
      var request = editingCourseId
        ? api('/courses/' + encodeURIComponent(editingCourseId), { method: 'PUT', body: body })
        : api('/courses', { method: 'POST', body: body });

      request
        .then(function () {
          resetFormToAddMode();
          loadCourseList();
        })
        .catch(function (err) {
          showFormError(form, err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = editingCourseId ? 'Update Course' : 'Add Course';
        })
        .then(function () {
          submitBtn.disabled = false;
        });
    });
  }).catch(function () {
    clearToken();
    window.location.href = 'login.html';
  });
}