# Intention v1.1.0

A major feature update focused on flexible time-blocking, deeper focus tools, and daily automation.

## Highlights

### Flexible Time Blocking (Teams-style calendar)
- Replaced the fixed hourly grid with a continuous 6 AM–11 PM calendar at 10-minute granularity
- Click and drag across any range (e.g., 12:00 PM–3:10 PM) to select a span and assign a task
- Assign priorities, to-dos, scheduled breaks, or a custom entry to any block
- Edit or remove blocks via left-click selection or a right-click context menu
- "Clear All" button to wipe the calendar
- Current-time indicator line that updates live, plus auto-scroll to the current time when opening the page

### Focus Mode
- System-wide greyscale using the Windows color filter
- Keeps your chosen window in color while everything else turns grey when it isn't full screen

### Distraction Tracking
- Quick-tap distraction counter on the mini timer overlay
- End-of-session distraction timeline showing exactly when each distraction happened
- Tag each distraction with preset icons: phone, people, internal thought, or other
- Per-day distraction history

### Reflection & Pause Tracking
- Reflection prompt every 4 work sessions, including the distraction count
- Measures total pause time during a pomodoro

### Task Management
- "My 5 Priorities" list that carries over day to day
- Scheduled breaks as a task type
- Inline editing for to-do items and priorities
- Drag to reorder priorities

### History
- Daily pomodoro count with a color-coded monthly calendar heatmap
- Click any day to see pomodoros and a detailed distraction breakdown

### Daily Automation
- Pomodoro session count resets at midnight
- Time-block calendar clears at midnight for a fresh schedule each day

### Customization
- Customizable work, short break, and long break durations

## Notes
- Windows installer available via `node build.js win`
- macOS `.dmg` builds available on macOS via `node build.js mac` or through the GitHub Actions workflow
