# TalkReady frontend

React and Vite frontend for TalkReady. Requests to `/api` and `/socket.io` are
proxied to the local backend at `http://localhost:5000`.

## Run locally

1. Install Node.js (20.19+ or 22.12+).
2. From this directory, install dependencies:

   ```sh
   npm install
   ```

3. Optionally copy `.env.example` to `.env` and set `VITE_API_URL`. Leave it
   empty to use the local proxy.
4. Start the development server:

   ```sh
   npm run dev
   ```

Open `http://localhost:5173`. To create a production build, run `npm run build`.
The app shell and styles are served locally; no CDN fonts, scripts, or icons are
used.

## Local API and session behavior

The frontend expects the backend to expose the `/api/auth/*` endpoints and
`/api/health` on port 5000. Authenticated requests use the token in
`localStorage`; student and admin pages are protected by their respective roles.
The navigation status checks browser connectivity, the backend health endpoint,
and the interview socket connection.
