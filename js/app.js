// ===== Navigation & Page Management =====
const navLinks = document.querySelectorAll('.nav-link');
const pages = document.querySelectorAll('.page');
const miniTimer = document.getElementById('mini-timer');

// Scheduler (timeblock) is the landing page on launch
let currentPage = 'timeblock';

function switchPage(pageName) {
    currentPage = pageName;

    navLinks.forEach(link => {
        link.classList.toggle('active', link.dataset.page === pageName);
    });

    pages.forEach(page => {
        page.classList.toggle('active', page.id === `page-${pageName}`);
    });

    // Scroll the time-block calendar to the current time when opening it
    if (pageName === 'timeblock' && typeof window.scrollTimeBlockToNow === 'function') {
        setTimeout(() => window.scrollTimeBlockToNow(), 0);
    }

    // Show mini timer when not on timer page and timer is running
    updateMiniTimerVisibility();
}

function updateMiniTimerVisibility() {
    if (currentPage !== 'timer' && window.timerState && window.timerState.isRunning) {
        miniTimer.style.display = 'flex';
    } else {
        miniTimer.style.display = 'none';
    }
}

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        switchPage(link.dataset.page);
    });
});

// Mini timer controls
document.getElementById('mini-btn-toggle').addEventListener('click', () => {
    if (window.timerState && window.timerState.isRunning) {
        window.pauseTimer();
    } else {
        window.startTimer();
    }
});

document.getElementById('mini-btn-goto').addEventListener('click', () => {
    switchPage('timer');
});

// ===== Local Storage Helpers =====
function saveData(key, data) {
    localStorage.setItem(`focusflow_${key}`, JSON.stringify(data));
}

function loadData(key, fallback) {
    const data = localStorage.getItem(`focusflow_${key}`);
    return data ? JSON.parse(data) : fallback;
}

function removeData(key) {
    localStorage.removeItem(`focusflow_${key}`);
}
