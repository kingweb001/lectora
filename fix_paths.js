const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'college.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
        process.exit(1);
    }
    console.log('Connected to database at', dbPath);
});

async function fixPaths() {
    db.serialize(() => {
        // 1. Fix messages table
        // Remove "/ uploads /" and replace with "/uploads/"
        // Also remove any leading/trailing spaces if any

        // We will select all, fix in JS, and update back because SQLite string functions are limited
        db.all("SELECT id, file_path FROM messages WHERE file_path LIKE '% %'", [], (err, rows) => {
            if (err) {
                console.error('Error fetching messages:', err);
                return;
            }

            console.log(`Found ${rows.length} messages with potential bad paths.`);

            rows.forEach(row => {
                if (!row.file_path) return;

                let newPath = row.file_path.replace(/\/ uploads \//g, '/uploads/');
                newPath = newPath.replace(/ \/ /g, '/'); // Generic " / " -> "/"
                newPath = newPath.replace(/ /g, ''); // Remove ALL spaces (filenames shouldn't have spaces in this system usually, or we assume they were introduced by the bug)
                // Wait, filenames might legitimately have spaces? 
                // The bug was `/ uploads / filename `.
                // Let's be specific: replace "/ uploads / " with "/uploads/"

                let betterPath = row.file_path;
                // Fix the specific known pattern
                betterPath = betterPath.replace(/\/ uploads \/ /g, '/uploads/');
                betterPath = betterPath.replace(/\/ uploads \//g, '/uploads/');
                // also fix end
                betterPath = betterPath.trim();

                // Brute force remove spaces from the beginning of filename if any
                // /uploads/ image.jpg -> /uploads/image.jpg
                betterPath = betterPath.replace(/\/uploads\/ /g, '/uploads/');

                if (betterPath !== row.file_path) {
                    console.log(`Fixing message ${row.id}: '${row.file_path}' -> '${betterPath}'`);
                    db.run("UPDATE messages SET file_path = ? WHERE id = ?", [betterPath, row.id], (updateErr) => {
                        if (updateErr) console.error(`Failed to update message ${row.id}:`, updateErr);
                    });
                }
            });
        });

        // 2. Fix users avatar
        db.all("SELECT id, avatar FROM users WHERE avatar LIKE '% %'", [], (err, rows) => {
            if (err) return;
            rows.forEach(row => {
                if (!row.avatar) return;
                let newPath = row.avatar.replace(/\/ uploads \/ /g, '/uploads/');
                newPath = newPath.replace(/\/ uploads \//g, '/uploads/');
                newPath = newPath.trim();
                newPath = newPath.replace(/\/uploads\/ /g, '/uploads/');

                if (newPath !== row.avatar) {
                    console.log(`Fixing user ${row.id} avatar: '${row.avatar}' -> '${newPath}'`);
                    db.run("UPDATE users SET avatar = ? WHERE id = ?", [newPath, row.id]);
                }
            });
        });

        // 3. Fix stories images
        db.all("SELECT id, image FROM stories WHERE image LIKE '% %'", [], (err, rows) => {
            if (err) return;
            rows.forEach(row => {
                if (!row.image) return;
                let newPath = row.image.replace(/\/ uploads \/ /g, '/uploads/');
                newPath = newPath.replace(/\/ uploads \//g, '/uploads/');
                newPath = newPath.trim();
                newPath = newPath.replace(/\/uploads\/ /g, '/uploads/');

                if (newPath !== row.image) {
                    console.log(`Fixing story ${row.id} image: '${row.image}' -> '${newPath}'`);
                    db.run("UPDATE stories SET image = ? WHERE id = ?", [newPath, row.id]);
                }
            });
        });
    });

    // Give it a second to finish async updates then exit
    setTimeout(() => {
        console.log('Cleanup finished.');
        db.close();
    }, 2000);
}

fixPaths();
