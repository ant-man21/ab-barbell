# ab-barbell

**A/B Barbell** is a phone workout tracker for an alternating two-workout barbell program.
It installs to the iPhone home screen (or the Mac Dock), works offline at the gym,
syncs your log to your account and sends real lock-screen notifications.

- **Workout A:** Squat, Overhead Press, Deadlift
- **Workout B:** Bench Press, Pull-ups, Squat

## How it fits together

| Part | What it does |
|---|---|
| `app/` | The app itself: plain HTML/CSS/JS. `app/index.html` holds everything; the `PROGRAM` block near the top of its script sets the workouts, sets × reps and progression rules. |
| `app/sw.js` | Offline support and notification display. Bump `VERSION` when app files change. |
| `worker/src/` | The server, running free on Cloudflare Workers: passkey (Face ID) sign-in, the cloud copy of your log, and push notifications for training-day reminders and the rest timer. |
| `wrangler.toml` | Cloudflare settings. `ALLOW_SIGNUPS = "false"` stops anyone else creating an account. |
| `test/` | Checks for notification encryption and reminder times (`npm test`). |

Your data lives on your phone first, so the app works without signal, and syncs to
your account whenever it's online. Each account's data is stored separately on Cloudflare.

## Hosting

Cloudflare builds and publishes the app and server straight from this repo
(Cloudflare **Workers & Pages → Create → Import a repository → ab-barbell**).
Every push to `main` goes live automatically; no keys or GitHub secrets are needed.

The app lives at **https://ab-barbell.ant21san.workers.dev/**. The old GitHub Pages
address now shows a page pointing there (`moved/`).

## Install on iPhone

1. Open the app's address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it from the home screen icon and create your account with Face ID.
4. In **Program → Notifications**, tap **Turn on notifications**. iPhone only allows
   notifications for apps opened from the home screen (iOS 16.4 or later).

On a Mac, open the address in Safari and choose **File → Add to Dock**. Your passkey
syncs through iCloud Keychain, so you sign in with Touch ID there.

## Local development

```sh
npm install
npx wrangler dev      # app + server on http://localhost:8787
npm test
```

## Strength metric

Strength is the estimated one-rep max from the best set of each session
(Epley: weight × (1 + reps ÷ 30)), with body weight added for pull-ups.
Volume (sets × reps × weight) shows progress from added sets.
