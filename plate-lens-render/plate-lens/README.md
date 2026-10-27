# Plate Lens

Drop in a food photo and get calories, protein, carbs, fat and fiber, ingredient by ingredient.

The site is one small Node server (no dependencies to install) plus one page. The server holds your Anthropic API key and sends each photo to Claude. The key never reaches the browser.

```
plate-lens/
├── public/index.html   the page
├── server.js           serves the page and handles /api/analyze
├── package.json
├── render.yaml         optional, lets Render configure itself
├── .gitignore
└── README.md
```

## 1. Get an API key (3 minutes)

1. Go to https://console.anthropic.com and sign in.
2. Add a small amount of credit under Billing. Each photo costs a fraction of a cent to a few cents, so $5 goes a long way. Check the current pricing on the console.
3. Under Billing or Limits, set a monthly spend limit so the bill can never surprise you.
4. Open API Keys, choose Create Key, name it `plate-lens`, and copy it. It starts with `sk-ant-` and is shown only once.

Never paste the key into any file in this project or into GitHub. It goes into Render in step 3.

## 2. Put the project on GitHub (no git knowledge needed)

1. Unzip `plate-lens-render.zip` on your computer.
2. Go to https://github.com/new, name the repository `plate-lens`, leave everything else as is, and choose Create repository.
3. On the new repository page, choose "uploading an existing file".
4. Drag the contents of the unzipped folder into the browser: `public`, `server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md`. Drag the `public` folder itself, not just the file inside it, so the path stays `public/index.html`.
5. Choose Commit changes.

Public or private both work. Private is fine and keeps your project to yourself.

## 3. Deploy on Render

1. Go to https://render.com and sign up, using "Continue with GitHub" for the easiest connection.
2. Choose New, then Web Service, then pick the `plate-lens` repository (Render will ask for permission to see it the first time).
3. Fill in:
   - Name: `plate-lens` (this becomes part of your web address)
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
4. Open Environment Variables and add:
   - Key `ANTHROPIC_API_KEY`, value: the key you copied in step 1
5. Choose Create Web Service. The first deploy takes a couple of minutes. When the log says "Plate Lens on port ... key set", open the address at the top of the page (`https://plate-lens.onrender.com` or similar).

Shortcut: choose New, then Blueprint, instead. Render reads `render.yaml` and fills in the settings above. You still paste the API key when asked.

## Things to know

- Free Render services go to sleep after about 15 minutes without visitors. The next visit takes 30 to 60 seconds to wake up. After that it is fast.
- Limits protect your bill. By default each visitor can analyze 10 photos per hour, and the whole site 150 per day. To change them, edit the environment variables `LIMIT_PER_IP_HOUR` and `LIMIT_PER_DAY` in Render. The daily limit is the real safety net, and it resets at midnight UTC. The counters live in memory, so a restart resets them. The spend limit you set in step 1 is the final backstop.
- Optional model setting: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`). A smaller model is cheaper, a larger one is more accurate.
- To update the site, edit a file on GitHub. Render redeploys by itself.
- The Today log is saved in each visitor's own browser and clears at midnight. It is never sent to your server.

## If something goes wrong

- "Server not set up": the API key is missing or wrong. In Render, open Environment, re-paste the key, and save. Check that your Anthropic account has credit.
- "Daily limit reached": raise `LIMIT_PER_DAY`, or wait until tomorrow.
- Blank page or "Not found": make sure `public/index.html` is in the repository at exactly that path.
- Render logs (the Logs tab) show the real error behind any failure.

## Run it on your own computer (optional)

Needs Node 18 or newer.

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Then open http://localhost:3000.
