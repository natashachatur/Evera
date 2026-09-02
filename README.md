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

Whenever you (or Claude) have a new version of `index.html`, commit, tag it with the matching version number, and push both:

```bash
cd ~/Development/Evera
git add .
git commit -m "Describe what changed"
git tag v1.6.0
git push
git push --tags
```

GitHub Pages redeploys automatically within a minute or two of the push. Claude will give you the exact commit message and tag to use each time, matching the version it just added to the in-app changelog.

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

## Logo thickness/width controls, cleaner Wedding Party hub, per-event colour & budget, task dependencies, and a round of polish (v1.6.0)

- **Logo design studio**: text, icons, and shapes can now each have their **Thickness** (font weight for text, stroke weight for icons/shapes) and **Width** (independent horizontal stretch) adjusted, alongside the existing Letter Spacing control. The logo preview on Home's Personalize Your Space card is now full-width so the monogram is easier to see clearly.
- **Wedding Party Hub**: removed the duplicate contacts list — members are now shown once, as cards, instead of listed twice.
- **"My Wedding" is now called "My Wedding Blueprint"** throughout the app.
- **Events**: each event can now have its own **Colour Palette** (start from your Master Palette or set an entirely different one) and its own **Sub-Budget Target**, shown alongside how much of that target is planned/spent from linked budget line items. The main Budget module's "By Event" view now shows each event's target next to its actuals.
- **Plan**: tasks can now have **notes** and a **dependency** on another task — a task can't be checked off while the task it depends on is still open.
- **Altar Lineup**: fixed a bug where the same person could be added to both sides of the aisle (each side's dropdown now excludes anyone already placed on either side), and straightened out the misaligned/"squiggly" row of names.
- **Landing page & onboarding polish**: sharper sub-copy, a "One wedding. Every celebration. One plan." tagline, and mood-descriptor words (e.g. "Timeless • Formal • Refined") under each aesthetic style option.

## Your guest-facing wedding website (v1.5.0)

Alongside `index.html` (the couple's planning app), this folder now also includes **`wedding-website.html`** — a separate, self-contained prototype of what your guests would actually see. Open it the same way (double-click, or `open wedding-website.html`).

- **Our Story**: written from prompt-question answers (how you met, the proposal, what you're looking forward to, a fun fact) plus a milestone-photo gallery — both configured from the **Website & RSVP** module in the main app.
- **Wedding Party**: bios and photos, pulled from each person's profile in the **Wedding Party Hub** (there's a new "Wedding Website Bio" field on each member's page).
- **Events**: a tab per event, each one gated — a guest only sees the events they're actually invited to. Every event page includes a "+ Add to Google Calendar" button and a downloadable `.ics` file, plus a polished dress-code section (an illustrated attire moodboard, matching the same style used in the main app's Events module) with real attire-retailer links.
- **Album**: event photos, filterable by event, with a "new photos are up" banner the couple can trigger from Website & RSVP.
- **Travel**: shuttle, flying, rideshare and transit info, plus Things To Do and Eat & Drink recommendation cards.
- **FAQ**: an accordion built from the couple's guided FAQ Builder selections in Website & RSVP.
- **RSVP**: shows the couple's chosen RSVP-by date and a simple RSVP form. This is a prototype — responses aren't saved anywhere yet, and automated reminders for guests who haven't responded are a planned future feature, not built yet.

Since there's no real guest sign-in in this prototype, the website has a **"Viewing as"** picker at the top so you can preview it as different guests with different event invitations, to see the per-event gating in action.

All of the content on this page (Our Story, Travel, FAQ, Wedding Party bios) is sample data for now — wiring it up to read live from the couple's actual Website & RSVP settings would be the next step once this prototype direction is approved.

## Home quick stats, palette themes, dress-code presets, Assistant toggle & a logo design studio (v1.4.0)

- **Home** now opens with a Quick Stats row — days to go, budget used, RSVPs in, planning progress, guests attending — visible without scrolling.
- **Master Record**: Partner 1 and Partner 2's first/last name fields are grouped so they always stay together on screen. The **Master Colour Palette** card now suggests descriptive theme words (e.g. "Earthy", "Romantic", "Airy") based on your chosen colours and aesthetic notes.
- **Evera Assistant** can be turned on or off during onboarding, and changed anytime in Settings.
- **Events → Dress Code** is now a dropdown of standard categories (Casual, Cocktail, Formal/Black-Tie, Festive & Colourful, etc.) with a short description of each, plus an "Other" option for anything custom.
- **Logo design studio**: from Home's Personalize Your Space card, "🎨 Design Your Own" opens a freeform logo editor — add text, icons and shapes; drag to move, use the top handle to rotate and the corner handle to resize; pick fonts (including a script font) and colours; reorder layers; save multiple named versions; and export the finished logo as a PNG or SVG. Whichever version you set as your Wedding Logo is saved to your account and used as your logo everywhere else in the app.

## Partner names, hashtag suggestions & name-change tracking

The Master Record now splits each partner's name into **First** and **Last** name fields (instead of one combined name field per partner) — the rest of the app still displays the combined "First Last" form wherever it showed a partner's name before.

Next to the **Wedding Hashtag** field, an **✨ Suggest** button generates a handful of hashtag ideas from both partners' first/last names and the wedding year (e.g. `#JordanAndSam2027`, `#TheReyeses2027`) — click one to use it.

A new **Name Change** card lets each partner record whether they're keeping their name, taking their partner's last name, hyphenating, or doing something else, plus what their new last name will be. If a partner opts into a name change, once the wedding date has passed a **Name Change Checklist** unlocks for them — a step-by-step walkthrough (marriage certificate copies, Social Security/ID, passport, banks, employer/HR, insurance, voter registration, utilities, online accounts, legal documents) with progress tracking. All of this — first/last names and name-change choices/checklist progress — saves to Firestore the same way the rest of the Master Record does.

No further setup is needed to use any of this — the Firebase project, web app, Email/Password sign-in, Firestore database, and its security rules are all already configured and live.

## Changelog ("What's New") & versioning

There's a **🆕 What's New** link at the bottom of the sidebar (it also shows the current version number, e.g. `v1.3.0`). It opens a running changelog of every feature that's shipped to Evera so far, grouped by release (newest first) — this is the same list Claude keeps updated in `CHANGELOG` near the top of `index.html`'s script whenever a batch of changes ships.

Every release is numbered **major.minor.patch** (semantic versioning):

- **Patch** (`1.3.0` → `1.3.1`) — a batch that's only fixes or small tweaks to things already shipped, no new capability.
- **Minor** (`1.3.0` → `1.4.0`) — a batch that adds new features or functionality (this is the normal case).
- **Major** (`1.x.x` → `2.0.0`) — a big milestone or a change that reworks how an existing feature behaves. Rare, judgment call.

**How future updates work from here on:** rather than pushing every small change the moment it's built, changes get grouped into batches and pushed together only when you say to push. Each batch becomes one new version-bumped changelog entry, and the git commit for that push gets tagged with the matching version (e.g. `git tag v1.4.0`), so the version number, the changelog, and git history all line up with what's actually live.

## Notes on this version

- This `index.html` was exported from the published Claude Artifact version of the prototype, then had real Firebase Authentication wired in (as of Sep 2, 2026) — still one self-contained file with all CSS and JavaScript inline (Firebase's SDK is loaded from Google's CDN at the top of the file's closing `<script type="module">` tag).
- A few things that rely on the browser's native download/print dialogs (the Playbook `.txt` exports, the Mailing List CSV export, and the floor-plan print button) will now work properly once this is opened as a real page (they didn't work inside the Claude Artifact's embedded viewer, but do work here and will work on GitHub Pages).
- All wedding-planning data in this prototype (guests, budget, vendors, etc.) is still fictional sample data and resets each time the page is freshly loaded — only the account/sign-in layer is real so far.
