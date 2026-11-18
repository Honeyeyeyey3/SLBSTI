# SLBSTI website (with database)

Public website, admin panel, student portal, logo upload, fee payment QR.
Node.js server + PostgreSQL database. Deploys on Render.

## Put it live on Render (step by step)

### 1. Put the files on GitHub
1. Make a free account at github.com and click New repository. Name it `slbsti`, choose Private, click Create.
2. Click "uploading an existing file".
3. Unzip this project on your computer. Select everything inside the folder (server.js, package.json,
   render.yaml, README.md, and the `public` folder) and drag it into the GitHub page.
   Do not upload a `node_modules` or `data` folder if you have one.
4. Click Commit changes.

### 2. Create the database on Render
1. Sign up at render.com with your GitHub account.
2. Click New + > Postgres. Name: `slbsti-db`. Pick the region closest to you (for example Singapore).
3. Pick an instance type:
   - Free: works for testing, but Render deletes a free database 30 days after creation. Do not use it for real student data.
   - A paid instance (the smallest one) keeps your data permanently. Choose this for the real site.
   - Another option is a free Postgres from another company (for example Neon). Check their current free terms first.
4. Click Create Database and wait until it says Available.
5. On the database page copy the **Internal Database URL**. (If your database is from another company, copy its connection string instead.)

### 3. Create the website on Render
1. Click New + > Web Service and choose your `slbsti` GitHub repository.
2. Fill in:
   - Name: `slbsti`
   - Region: the same region as the database
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance type: Free to test (it sleeps after 15 minutes without visitors and takes about a minute to wake up). Choose a paid type if the site must always be instantly available.
3. Open Environment Variables and add these three:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = the URL you copied from the database
   - `ADMIN_PASSWORD` = the admin password you want (at least 6 characters)
4. Click Create Web Service. After a few minutes you get a link like `https://slbsti.onrender.com`.

### 4. First use
1. Open your link and click Admin. Username: `admin`, password: the `ADMIN_PASSWORD` you set.
2. Site settings: upload your logo, fill in name, address and phone.
3. Fee and QR: upload your payment QR, set the fee amount and UPI ID.
4. Add listings (courses, notices, events) and add students.
5. Give each student their registration number and password. Students log in from "Student login" on any phone.

## Forgot the admin password?
In Render open your web service > Environment, add `RESET_ADMIN_PASSWORD` with a new password, and save.
After you can log in, delete that variable.

## Run on your own computer (optional)
1. Install Node.js from nodejs.org.
2. In this folder run `npm install` and then `npm start`.
3. Open http://localhost:3000 . Admin login is `admin` / `admin123` in this local mode.
   Data is saved in the `data` folder.
