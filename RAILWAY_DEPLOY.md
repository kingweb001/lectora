# Railway Deployment Guide for Lectora Server

## Quick Start

### Option 1: Deploy via Railway Dashboard (Easiest)

1. **Create Railway Account**
   - Go to https://railway.app
   - Sign up with GitHub or email

2. **Create New Project**
   - Click "New Project"
   - Select "Deploy from GitHub repo" OR "Empty Project"

3. **If using GitHub:**
   - Connect your GitHub account
   - Select your repository
   - Railway will auto-detect Node.js

4. **If using Empty Project:**
   - Create project
   - We'll deploy via CLI (see Option 2)

5. **Add PostgreSQL Database**
   - In your project dashboard
   - Click "New" → "Database" → "Add PostgreSQL"
   - Railway automatically creates `DATABASE_URL` environment variable

6. **Configure Environment Variables**
   - Go to your service → "Variables" tab
   - Add these variables:
   
   ```
   NODE_ENV=production
   PORT=3000
   JWT_SECRET=<generate-strong-secret-here>
   ALLOWED_ORIGINS=*
   MAX_FILE_SIZE=10485760
   UPLOAD_PATH=./uploads
   ```

   **To generate JWT_SECRET:**
   - Run in terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - Copy the output

7. **Deploy**
   - Railway will automatically deploy
   - Wait for build to complete

8. **Get Your URL**
   - Go to "Settings" → "Networking"
   - Click "Generate Domain"
   - Copy your URL (e.g., `https://lectora-production.up.railway.app`)

---

### Option 2: Deploy via Railway CLI

1. **Install Railway CLI**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login**
   ```bash
   railway login
   ```

3. **Initialize Project**
   ```bash
   cd server
   railway init
   ```

4. **Link to PostgreSQL**
   ```bash
   railway add
   # Select "PostgreSQL"
   ```

5. **Set Environment Variables**
   ```bash
   railway variables set NODE_ENV=production
   railway variables set PORT=3000
   railway variables set JWT_SECRET=your-secret-here
   railway variables set ALLOWED_ORIGINS=*
   railway variables set MAX_FILE_SIZE=10485760
   railway variables set UPLOAD_PATH=./uploads
   ```

6. **Deploy**
   ```bash
   railway up
   ```

7. **Get Domain**
   ```bash
   railway domain
   ```

---

## Important Notes

### Database Migration

The current code uses SQLite, but Railway requires PostgreSQL. You need to:

1. **Keep SQLite for local development**
2. **Use PostgreSQL for production**

The code will need a small update to support both (I can help with this).

### File Uploads

Railway's filesystem is ephemeral. For production file uploads, you should use:
- AWS S3
- Cloudinary
- Railway Volumes (persistent storage)

For now, uploads will work but may be lost on redeploy.

### Environment Variables

Never commit `.env` file! Railway manages environment variables securely.

---

## Testing Your Deployment

After deployment, test these endpoints:

1. **Health Check**
   ```bash
   curl https://your-app.railway.app/api/health
   ```

2. **Login Test**
   ```bash
   curl -X POST https://your-app.railway.app/api/login \
     -H "Content-Type: application/json" \
     -d '{"identifier":"rep@college.edu","password":"admin","role":"representative"}'
   ```

---

## Cost

- **Free Tier**: $5 credit/month
- **After Free Tier**: ~$5-10/month
- **PostgreSQL**: Included in usage

---

## Next Steps

After successful deployment:

1. ✅ Copy your Railway URL
2. ✅ Update mobile app's `socket.js` with new URL
3. ✅ Test app with production server
4. ✅ Proceed to app building phase

---

## Troubleshooting

### Build Fails
- Check Railway logs in dashboard
- Ensure `package.json` has correct start script
- Verify all dependencies are listed

### Database Connection Error
- Ensure PostgreSQL is added to project
- Check `DATABASE_URL` is set automatically
- Update code to use PostgreSQL (I can help)

### App Crashes
- Check logs: `railway logs`
- Verify environment variables are set
- Ensure PORT is set to 3000

---

## Support

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Railway Status: https://status.railway.app
