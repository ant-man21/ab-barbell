# ab-barbell

**A/B Barbell** is a phone workout tracker for an alternating two-workout barbell program.
It is a plain HTML/CSS/JS web app that installs to the iPhone home screen
(or the Mac Dock) and works offline. There is no build step and no server.

- **Workout A:** Squat, Overhead Press, Deadlift
- **Workout B:** Bench Press, Pull-ups, Squat

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app. The `PROGRAM` block near the top of the script holds the workouts, sets × reps and progression rules. |
| `manifest.webmanifest` | App name, icon and full-screen setting for "Add to Home Screen". |
| `sw.js` | Offline support. Bump `VERSION` when the app changes so phones fetch the new copy. |
| `icons/` | Home-screen icons. |

## Hosting

`.github/workflows/pages.yml` publishes the app to GitHub Pages on every
push to `main`. One-time setup in the repo:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

The app is then at `https://ant-man21.github.io/ab-barbell/`.

## Install on iPhone

1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open it from the home screen icon. It runs full screen and offline.

On a Mac, open the link in Safari and choose **File → Add to Dock**.

## Data

Workouts are stored on the device (browser storage for the installed app).
Use **Program → Back up** to save a copy and **Restore** to load it on another device.
Reminders come from **Program → Add reminders to Calendar**, which adds a weekly
repeating event with an alert on your training days.

## Strength metric

Strength is the estimated one-rep max from the best set of each session
(Epley: weight × (1 + reps ÷ 30)), with body weight added for pull-ups.
Volume (sets × reps × weight) shows progress from added sets.
