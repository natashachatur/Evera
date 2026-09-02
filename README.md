# Evera — Wedding Planning Prototype

This is the interactive HTML prototype of the Evera couple-facing wedding planning app. It's a single self-contained page (`index.html`) — no build step, no server required.

## View it locally

Just double-click `index.html`, or from Terminal:

```bash
open index.html
```

## Push this to GitHub (one-time setup)

These commands assume you're in this folder (`~/Development/Evera`) in Terminal. This folder is already a git repo with one placeholder commit — no need to run `git init` again.

1. **Stage and commit the prototype files:**

   ```bash
   cd ~/Development/Evera
   git add .
   git commit -m "Add Evera prototype"
   ```

2. **Create the GitHub repository.**

   Easiest way — using the GitHub CLI (if you have it installed: `brew install gh`, then `gh auth login`):

   ```bash
   gh repo create evera --public --source=. --remote=origin --push
   ```

   This creates the repo on your account, wires up the remote, and pushes in one step — skip to step 4.

   Otherwise, create it manually:
   - Go to https://github.com/new
   - Repository name: `evera`
   - Leave it empty (no README, no .gitignore, no license — you already have those)
   - Click **Create repository**

3. **Connect this folder to the new repo and push** (skip this step if you used the `gh repo create ... --push` command above, which already does this):

   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/evera.git
   git push -u origin main
   ```

   Replace `YOUR-USERNAME` with your GitHub username.

   **Prefer a GUI?** Since this repo was set up with Git LFS defaults (the `.gitattributes` file), it looks like it may have been created with **GitHub Desktop**. If you have that app, you can instead open it, add this repository (File → Add Local Repository → choose `~/Development/Evera`), commit the changes there, and click **Publish repository** — that handles steps 2 and 3 for you with no Terminal needed.

## Turn on GitHub Pages (get a live URL)

1. On GitHub, go to your `evera` repo → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
3. Under **Branch**, choose `main` and `/ (root)`, then **Save**.
4. Wait a minute or two, then refresh — GitHub will show your live URL, something like:

   ```
   https://YOUR-USERNAME.github.io/evera/
   ```

That URL is now live and shareable. Anyone with the link can open the prototype in a browser — no download needed.

## Updating it later

Whenever you (or Claude) have a new version of `index.html`:

```bash
cd ~/Development/Evera
git add .
git commit -m "Describe what changed"
git push
```

GitHub Pages redeploys automatically within a minute or two of the push.

## Real sign-in (Firebase Auth)

This version connects to a real Firebase project (`evera-0824`) for account creation and sign-in:

- **"Start Planning"** on the landing page now opens a real **Create Account** form (email + password) using Firebase Authentication, before continuing into onboarding.
- **"Sign in"** opens a real **Sign In** form for an existing account.
- **"See a Sample Wedding"** is unchanged — it's still just a no-account demo view of fictional data.
- Once signed in, your session persists — reloading the page (or coming back later) skips straight past the landing page.
- Settings now shows who's signed in, with a real **Sign Out** button.

You can check the **Authentication → Users** tab in the [Firebase console](https://console.firebase.google.com/project/evera-0824/authentication/users) to see real accounts being created as people sign up.

## Real data persistence (Firestore) — "My Wedding" only, so far

The **My Wedding** module (partner names, wedding date, location, guest count estimate, total budget, traditions, colour palette, hashtag, and aesthetic notes) now actually saves to a real database (Cloud Firestore) per account:

- Editing any of those fields shows a **Saving… / Saved ✓** indicator next to "The Master Record" heading, and the change is written to Firestore about half a second after you stop typing.
- Signing out and back in (or reloading the page) restores your saved values instead of resetting to sample data.
- Each account's data lives in its own Firestore document at `weddings/{your-account-id}` — Firestore security rules (set in the Firebase console) enforce that only you can read or write your own document.
- **"See a Sample Wedding"** is still a no-account demo — it shows "Sample mode — not saved" instead of the save indicator, and never touches Firestore.

**Still sample data, not yet saved:** every other module — Guests, Budget, Vendors, Wedding Party, Playbook, Events, etc. — is still in-memory only and resets on reload. Guests is the natural next module to wire up the same way.

No further setup is needed to use any of this — the Firebase project, web app, Email/Password sign-in, Firestore database, and its security rules are all already configured and live.

## Notes on this version

- This `index.html` was exported from the published Claude Artifact version of the prototype, then had real Firebase Authentication wired in (as of Sep 2, 2026) — still one self-contained file with all CSS and JavaScript inline (Firebase's SDK is loaded from Google's CDN at the top of the file's closing `<script type="module">` tag).
- A few things that rely on the browser's native download/print dialogs (the Playbook `.txt` exports, the Mailing List CSV export, and the floor-plan print button) will now work properly once this is opened as a real page (they didn't work inside the Claude Artifact's embedded viewer, but do work here and will work on GitHub Pages).
- All wedding-planning data in this prototype (guests, budget, vendors, etc.) is still fictional sample data and resets each time the page is freshly loaded — only the account/sign-in layer is real so far.
