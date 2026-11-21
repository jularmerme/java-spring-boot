# Spring Boot: 0 to Hero (interactive course)

Zero-dependency local web app. Works offline.

## Run it
```
npm start
```
This starts a local server (default http://localhost:3000, auto-picks the next free port) and opens your browser.
Requires Node.js 16+ and nothing else: there is nothing to `npm install`.
Options: `npm run start:nobrowser`, or `node server.js --port 4000`, or set the `PORT` environment variable.
You can also just double-click `index.html`.

## Structure
```
spring_boot_course/
  index.html
  package.json, server.js   (npm start)
  README.md
  css/styles.css
  js/
    course.js          module/lesson list (titles, ids)
    app.js             renderer, syntax highlighter, progress tracking
    lessons/
      lesson-1.1.js ... lesson-7.3.js   one file per lesson (content + exercises)
  images/
    favicon.svg, favicon.ico, favicon-16/32/48.png,
    apple-touch-icon.png, icon-192.png, icon-512.png
```

## Features
- Sidebar with all modules and lessons, plus full-text search
- Per-lesson table of contents, syntax-highlighted code with file paths and Copy buttons
- Exercise checkboxes, lesson completion, overall progress bar, notes per lesson (saved in the browser)
- Dark mode

## Adding or editing a lesson
Edit `js/lessons/lesson-X.Y.js`:
```
LESSONS['X.Y']={
md:String.raw`...markdown...`,
exercises:[{"title":"Exercise 1","tasks":["task one","task two"]}]
};
```
Markdown dialect: `~~~lang path/File.java` code fences, `^inline code^`, `**bold**`, pipe tables, `-` and `1.` lists.
Use the section sign followed by a brace in place of a dollar sign followed by a brace (Spring placeholders); the app converts it when rendering.
To add a new lesson, also add it to `js/course.js` and add a script tag in `index.html`.
