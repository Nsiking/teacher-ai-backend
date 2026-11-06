# SmartClass Teacher AI - Backend + teacher app screens (version 12)

This is the server for the "SmartClass Teacher AI" Android app. It is a NEW project.
It is NOT Class Register, Report Cards or School Management. Do NOT run apply-sm-connection.js here.

What it does: teacher accounts (email or phone + password), AI lesson notes, questions,
worksheets and report comments, a saved library per teacher, daily free limits,
paid plans (set by you for now), and an admin page.

## Folder on your computer
C:\TEACHER AI\teacher-ai-backend

## A. Test it on your computer (free, fake AI answers)
1. Check Node: open Command Prompt (black window). Type:  node -v   and press Enter.
   It must show v22.13 or higher. If lower, install the LTS version from nodejs.org first.
2. In that same black window type:  cd /d "C:\TEACHER AI\teacher-ai-backend"
3. Type:  copy .env.example .env      (this makes your settings file)
4. Open the new .env file with Notepad. Change ADMIN_KEY to a long secret of your own. Save.
   (Leave AI_MOCK=1 for now. That gives fake AI answers so nothing is spent.)
5. In the black window type:  npm run dev
   You should see: "SmartClass Teacher AI backend running on port 3000 | AI: TEST MODE"
6. Open your browser and go to:  http://localhost:3000/   (this is the teacher app).
   The older plain test page is still at http://localhost:3000/test
7. Sign up, then try each type of generation. Open http://localhost:3000/admin to see the admin page.
8. To stop the server: click the black window and press Ctrl + C.

Optional full self-test (40 checks): in the same black window type:  npm test

## B. Put it on GitHub (new repository)
1. On github.com click New repository. Name: teacher-ai-backend. Private. Do NOT tick any extra boxes. Create.
2. In the black window (still in C:\TEACHER AI\teacher-ai-backend) type these one at a time:
   git init
   git add .
   git commit -m "Teacher AI backend v1"
   git branch -M main
   git remote add origin https://github.com/Nsiking/teacher-ai-backend.git
   git push -u origin main

## C. Deploy on Render
1. render.com > New > Web Service > pick the repo teacher-ai-backend.
2. Name: smartclass-teacher-ai. Runtime: Node. Build Command: npm install. Start Command: npm start.
3. Choose a paid plan (you need a disk to keep the database).
4. Under Disks add one: Name data, Mount Path /var/data, Size 1 GB.
5. Under Environment add:
   NODE_VERSION = 22.23.4
   DATA_DIR = /var/data
   ANTHROPIC_API_KEY = (your key from console.anthropic.com)
   AI_MOCK = 0
   ADMIN_KEY = (your long secret)
   TEST_PAGE = on   (change to off before the real app is public)
6. Create the service. When it is live open  https://YOUR-SERVICE.onrender.com/health  - it must show {"ok":true,...}

## The teacher app (opens at /)
Login and sign-up, Home with six tools (lesson note, scheme of work, questions, worksheet, marking assistant, report comments), a Classes tab (class lists, daily attendance, assessments and scores, overall sheet with CSV), forms, result screen (copy, share, Word, print/PDF, edit, delete),
My Library with search and filters, offline reading of saved items, Account (plan, change password,
delete account). The UPGRADE button opens WhatsApp. To change that number, edit SUPPORT_WHATSAPP
at the top of public/app.js.

## Plans (Free and Teacher Plus)
Free: 3 generations a day (20 a month), report comments for 5 pupils, marking 3 answers, 2 classes of 50 pupils,
newest 30 library items open (older ones are locked, never deleted), a footer line on Word and Share.
Teacher Plus (monthly N1,500, term N3,500, year N9,500): 30 a day, 40 pupils, 15 answers, 10 classes of 80, unlimited
library, no footer. Every number can be changed with a setting in Render (see .env.example).
A teacher who goes back to Free keeps all classes and pupils. Only adding more is blocked.
Activate a plan on /admin (Give a user a paid plan). School licences: /admin > "School licence" gives many teachers
a plan at once. A 7-day trial = give the plan for 7 days.

## Light and dark look
Account > Appearance: Automatic (follows the phone), Light or Dark. The choice is remembered, applied before the screen
draws (no flash), and kept after logging out. Colours were measured so text is easy to read in both looks.

## Contents from a photo
When adding or editing a textbook, "Read it from a photo" lets a teacher photograph the contents page (up to 3 photos).
The photo is shrunk on the phone, sent to the AI to read, and the lines come back into the contents box for the teacher
to check and edit. It counts as ONE generation (daily and monthly allowance) on every plan. It is given back if nothing
could be read. Photos are not stored. In test mode (AI_MOCK=1) it returns sample lines, so the screens can be tried free.
The AI is told to copy only what is printed, never to invent a chapter or page, and to mark unclear words with (?).
Test it:  node tests/photo-test.js

## Lesson Plan and Time-Table
Lesson Plan (Home): a short, timed plan: objectives, stages with teacher and learner activities, support and extension,
evaluation, assignment and a reflection box. It uses one generation, like the other AI tools, and can cite textbooks.
Time-Table (Home): "My timetable" is the teacher's own weekly periods. Today's lessons show on Home with Now and Next,
and tapping one starts a lesson plan or note for that subject and class. "Class timetable" makes a balanced class
timetable with no AI, so it is free and does not use a generation. Rules it follows: exact periods per subject, at most
2 a day, doubles side by side and never split by a break, core subjects early, free periods last.
Up to 80 periods per teacher (TIMETABLE_MAX_SLOTS). Test it:  node tests/timetable-test.js

## Textbook references
Teachers add the books their school uses (title, author, publisher, edition, year, ISBN, subject, classes, and the
contents list they type in). In Lesson Note, Scheme of Work, Questions and Worksheet they tick up to 3 books.
The AI may only use those books. The system writes the exact citation itself, so a title, author or edition can
never be invented. Chapters and pages come only from the contents list that was typed in.
Free teachers keep 5 books of their own, Teacher Plus keeps 30 (FREE_MAX_TEXTBOOKS, PAID_MAX_TEXTBOOKS).
/admin > "Textbook catalogue" holds verified books that every teacher can pick. Add only books you have checked.
Bulk line format: Title | Authors | Publisher | Edition | Year | ISBN | Subject | Classes
Test it:  node tests/textbook-test.js

## Legal pages (needed for the Google Play listing)
/privacy   /terms   /delete-account
Use these three web addresses in the Play Console (Privacy policy URL and the account deletion URL).
Contact email shown on them: support@smartclassaiacademy.com
Admin can also delete an account from /admin (for requests that come by email).

## Nightly backups (Cloudflare R2)
The database is copied to R2 every night after 2:00 am Nigerian time, and 30 days are kept.
Set these in the Render Environment tab (copy the values from your other SmartClass services):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (smartclass-backups)
Optional: R2_BACKUP_PREFIX (default teacher-ai-backups/), BACKUP_KEEP_DAYS (default 30).
The API token needs "Object Read & Write" on that bucket. Keep the bucket PRIVATE.
Check it on /admin: the "Database backups" card, with a "Back up now" button.
To restore (Render > this service > Shell):
  node scripts/restore.js --list          shows the backups
  node scripts/restore.js --latest        prepares the newest backup
  node scripts/restore.js --key NAME      prepares one backup
Then restart the service. The old database is kept as teacher.db.before-restore-<time>.
Test it:  node tests/backup-test.js

## Main addresses (for the Android app)
POST /api/auth/signup        POST /api/auth/login        GET /api/me
POST /api/me/password        DELETE /api/me   (account deletion, required by Google Play)
POST /api/generate/lesson-note | scheme-of-work | questions | worksheet | marking | report-comments
Classroom: /api/classes, /api/classes/:id/pupils, /attendance, /attendance/summary, /assessments, /sheet; /api/assessments/:id and /scores; /api/pupils/:id
GET /api/library   GET/PUT/DELETE /api/library/:id
GET /api/meta (classes, terms, limits)
Admin (header X-Admin-Key): /api/admin/stats, /users, /set-plan, /reset-password

## Settings (.env or Render Environment)
FREE_DAILY_LIMIT (default 3)   PAID_DAILY_LIMIT (default 30)
AI_MODEL_FREE (default claude-haiku-5-5)   AI_MODEL_PAID (default claude-sonnet-5-5)
