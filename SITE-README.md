# Portfolio site

A simple static portfolio for GitHub Pages, styled after the original
alexmyers.info. Content lives in `content/site.json` and is edited from the
admin page at `/admin/`.

- `index.html`: name GIF, tagline, intro and links, then a three-across grid
  of project thumbnails.
- `project.html?p=<address>`: one project, with a banner image, title,
  subtitle, description, then its images and videos, and "Other Projects".
- `page.html?p=<address>`: a text page such as Teaching.

## Put it online (one time)

1. Create a new **public** repository on GitHub (e.g. `portfolio`, or
   `yourname.github.io` to have the site live at that address).
2. Upload everything in this folder to the repository (drag the files onto the
   repo page → *Commit changes*). Include the hidden `.nojekyll` file.
3. In the repo go to **Settings → Pages**, set *Source* to **Deploy from a branch**,
   branch **main**, folder **/ (root)**, and save.
4. After a minute the site is live at `https://yourname.github.io/portfolio/`.

## Make an admin token (one time)

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. Under **Repository access** choose **Only select repositories** → this repo.
3. Under **Repository permissions**, set **Contents** to **Read and write**.
4. Generate it and copy it. When it expires, make a new one the same way.

## Editing

Open `https://yourname.github.io/portfolio/admin/`, paste the token, and sign in.

- **Site**: name, logo GIF, tagline, intro, and the list of links under the
  intro (an email address becomes a mail link).
- **Pages**: simple text pages such as Teaching, at `page.html?p=teaching`.
  Each page can have a link on the home page (a checkbox in its editor). Text
  formatting: a blank line starts a paragraph, `# Heading`, `## Small heading`,
  `> quote`, `- list item`, `[link text](https://…)`, `*italic*`, `**bold**`.
  The same formatting works in project descriptions and the intro.
- **Projects**: add, reorder, edit, delete. Each project has a title, year
  (shown when hovering its thumbnail), optional subtitle, address, description,
  a thumbnail for the home page grid, and a list of items in any order:
  images, video files (MP4), YouTube or Vimeo videos, and text blocks.
  - The **first image** is the wide banner at the top of the project page.
  - Everything else appears below the description, in order.
  - Images and videos can be **Full**, **Half** or **Third** width to sit
    side by side, like the grids on the old site.
  - To add a YouTube or Vimeo video, paste its link (or embed code) and press
    **Add video**. Video files can be dragged in like images (keep them under
    50 MB; GitHub refuses files over 100 MB).
- Nothing goes live until you press **Publish**. Each publish is one commit, and
  the live site refreshes about a minute later.

Photos are resized to 2400px on the long side and their camera/GPS data is
removed in your browser before upload. GIFs (including the logo) are uploaded
as-is so they keep animating.

The sample projects and images in `images/samples/` are placeholders. Delete
those projects in the admin and their images are removed too.

## Working locally (VS Code + Live Server)

1. Open **this folder** in VS Code (so `index.html` is at the top level) and click
   **Go Live**.
2. Open `http://127.0.0.1:5500/admin/` in **Chrome or Edge**.
3. Click **Choose website folder**, pick this folder, and allow editing.
   No GitHub token is needed locally.
4. Edit, then press **Save**. Changes go straight into `content/site.json` and
   `images/`. Refresh the site tab to see them.
5. When you're happy, commit and push (VS Code's Source Control panel or GitHub
   Desktop), and the live site updates.

**Using Firefox, Zen or Safari?** Those browsers can't save into a folder, so
the admin works in *download mode* instead: edit as usual, press **Download
changes**, and you get a small zip. Move `site.json` from its
`put-in-content-folder` into `content/` (replacing the old one), and the files
inside `put-in-images-folder` into `images/`. The zip's `HOW-TO-APPLY.txt` repeats
this and lists any images you removed that can now be deleted. Download before
closing or reloading the admin page, or unsaved edits are lost.

`.vscode/settings.json` tells Live Server not to auto-reload when the admin
saves, so it can't wipe out edits in progress. That's why you refresh the site
tab yourself.

## Content from the old site

All 30 projects from the previous alexmyers.info were moved into
`content/site.json`. Their images and videos stay where they always were, in
`imgs/`. New uploads from the admin go into `images/`.

The old project addresses (`pages/acre/index.html`, `pages/everything.html`,
and so on) are small redirect pages that forward to the new project pages, so
existing links keep working. `pages/teaching.html` forwards to the new Teaching
page and `pages/about.html` to the home page. Everything else in the repository
(`classes/`, `tenure/`, `models/`, `pages/officehours.html` and the other
older pages) is untouched and still works as before.

## Changing the look

The main settings are variables at the top of `assets/style.css`: link colour
(`--link`), course-title colour (`--subhead`), the grayscale treatment of the
name GIF (`--logo-filter`; set it to `none` to show the GIF in colour), and the
thumbnail shape (`--thumb-ratio`, 16:10 like the original site).

Open Sans is included in `assets/fonts/` (SIL Open Font License), so the site
doesn't depend on Google Fonts.

## Custom domain

Add your domain under **Settings → Pages → Custom domain**. On a custom domain
the admin can't guess the repository, so type it as `username/repo` when
signing in (it's remembered after that).
