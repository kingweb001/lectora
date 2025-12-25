# Fly.io Deployment Guide - مجاني 100%

## لماذا Fly.io؟

✅ **مجاني تماماً** - بدون بطاقة ائتمان  
✅ **PostgreSQL مجاني**  
✅ **HTTPS تلقائي**  
✅ **أداء ممتاز**  
✅ **لا يتوقف تلقائياً** (أفضل من Render!)  
✅ **3 GB رام مجانية**

---

## الخطوة 1️⃣: تثبيت Fly CLI

### في PowerShell:

```powershell
# تثبيت Fly CLI
iwr https://fly.io/install.ps1 -useb | iex
```

**أعد تشغيل PowerShell** بعد التثبيت.

### تحقق من التثبيت:

```powershell
fly version
```

---

## الخطوة 2️⃣: إنشاء حساب

```powershell
fly auth signup
```

سيفتح المتصفح:
1. أدخل بريدك الإلكتروني
2. اختر كلمة مرور
3. **لا تحتاج بطاقة ائتمان!** ✅

---

## الخطوة 3️⃣: تسجيل الدخول

```powershell
fly auth login
```

---

## الخطوة 4️⃣: إنشاء التطبيق

```powershell
cd c:\Users\moham\.gemini\antigravity\scratch\college_app\server
fly launch
```

سيسألك أسئلة:

1. **App Name:** اضغط Enter (سيختار اسم تلقائي) أو اكتب `lectora-server`
2. **Region:** اختر الأقرب لك:
   - `ams` - Amsterdam
   - `fra` - Frankfurt
   - `lhr` - London
3. **PostgreSQL:** اختر **Yes** ✅
4. **PostgreSQL Configuration:**
   - Development (مجاني) ✅
5. **Deploy now:** اختر **No** (سنعدل الإعدادات أولاً)

---

## الخطوة 5️⃣: تكوين المتغيرات

### توليد JWT Secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

انسخ الناتج.

### إضافة المتغيرات:

```powershell
fly secrets set JWT_SECRET=<الصق_هنا>
fly secrets set ALLOWED_ORIGINS="*"
fly secrets set MAX_FILE_SIZE=10485760
fly secrets set UPLOAD_PATH="./uploads"
```

---

## الخطوة 6️⃣: النشر

```powershell
fly deploy
```

**انتظر 2-5 دقائق** حتى يكتمل البناء والنشر.

---

## الخطوة 7️⃣: الحصول على الرابط

```powershell
fly status
```

ستجد الرابط:
```
https://lectora-server.fly.dev
```

أو:
```powershell
fly open
```

سيفتح التطبيق في المتصفح.

---

## الخطوة 8️⃣: اختبار الخادم

### Health Check:

```powershell
fly open /api/health
```

أو في المتصفح:
```
https://lectora-server.fly.dev/api/health
```

يجب أن ترى:
```json
{
  "success": true,
  "message": "Server is running",
  "timestamp": "..."
}
```

### اختبار تسجيل الدخول:

```powershell
$url = "https://lectora-server.fly.dev"
$body = @{
    identifier = "rep@college.edu"
    password = "admin"
    role = "representative"
} | ConvertTo-Json

Invoke-RestMethod -Uri "$url/api/login" -Method POST -Body $body -ContentType "application/json"
```

---

## الخطوة 9️⃣: تحديث التطبيق

### تحديث socket.js:

افتح:
```
mobile-client/src/utils/socket.js
```

**غيّر السطر 5:**
```javascript
// قبل
const DEFAULT_SERVER_URL = 'http://172.20.10.2:3000';

// بعد
const DEFAULT_SERVER_URL = 'https://lectora-server.fly.dev';
```

**احفظ الملف** ✅

---

## الخطوة 🔟: اختبار التطبيق

```powershell
cd ..\mobile-client
npm start
```

اختبر:
- ✅ تسجيل الدخول
- ✅ الدردشة
- ✅ رفع الملفات
- ✅ الإشعارات

---

## 🎉 تم النشر بنجاح!

---

## 📊 الموارد المجانية

| المورد | المجاني |
|--------|---------|
| RAM | 3 GB |
| CPU | Shared |
| PostgreSQL | 3 GB |
| Bandwidth | 160 GB/شهر |
| **التكلفة** | **$0** ✅ |

---

## 🔧 أوامر مفيدة

```powershell
# عرض السجلات
fly logs

# عرض حالة التطبيق
fly status

# فتح لوحة التحكم
fly dashboard

# إيقاف التطبيق
fly apps stop lectora-server

# تشغيل التطبيق
fly apps start lectora-server

# حذف التطبيق
fly apps destroy lectora-server

# الاتصال بقاعدة البيانات
fly postgres connect -a <db-name>
```

---

## ⚠️ ملاحظات مهمة

### قاعدة البيانات

> [!IMPORTANT]
> الكود الحالي يستخدم SQLite. يجب تحديثه لـ PostgreSQL.
> أخبرني لأساعدك في هذا!

### رفع الملفات

> [!TIP]
> استخدم Volumes للملفات الدائمة:
> ```powershell
> fly volumes create data --size 1
> ```

---

## 🆚 Fly.io vs Render

| الميزة | Fly.io | Render |
|--------|--------|--------|
| التوقف التلقائي | ❌ لا | ✅ نعم (15 دقيقة) |
| RAM مجانية | 3 GB | 512 MB |
| PostgreSQL | 3 GB | 1 GB |
| الأداء | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

**Fly.io أفضل!** ✅

---

## الخطوات التالية

1. ✅ نسخ رابط Fly.io
2. ✅ تحديث `socket.js`
3. ⚠️ تحديث الكود لـ PostgreSQL
4. ✅ اختبار التطبيق
5. ✅ بناء بـ EAS
6. ✅ النشر على المتاجر

---

## 🆘 المساعدة

- **Fly.io Docs:** https://fly.io/docs
- **Fly.io Community:** https://community.fly.io
- **أو اسألني!** 😊

---

## ✅ قائمة التحقق

- [ ] تثبيت Fly CLI
- [ ] إنشاء حساب
- [ ] تسجيل الدخول
- [ ] إنشاء التطبيق
- [ ] إضافة PostgreSQL
- [ ] تكوين المتغيرات
- [ ] النشر
- [ ] اختبار الخادم
- [ ] تحديث التطبيق
- [ ] اختبار كامل

**ابدأ الآن! 🚀**
