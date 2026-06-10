const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon') ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, name TEXT NOT NULL,
            role TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS pharmacies (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL,
            address TEXT, phone TEXT, website TEXT, opening_hours TEXT,
            is_24h BOOLEAN DEFAULT FALSE, lat REAL NOT NULL, lon REAL NOT NULL,
            rating REAL, reviews_count INTEGER, verified BOOLEAN DEFAULT FALSE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS favorites (
            id SERIAL PRIMARY KEY,
            pharmacy_id TEXT REFERENCES pharmacies(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, note TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS medicines (
            id SERIAL PRIMARY KEY,
            pharmacy_id TEXT REFERENCES pharmacies(id) ON DELETE CASCADE,
            name TEXT NOT NULL, price DECIMAL(10,2),
            in_stock BOOLEAN DEFAULT TRUE, description TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pharmacies_lat_lon ON pharmacies (lat, lon)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pharmacies_source ON pharmacies (source)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_pharmacies_updated ON pharmacies (updated_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_medicines_pharmacy ON medicines(pharmacy_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)`);

        const adminExists = await pool.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
        if (adminExists.rows.length === 0) {
            const bcrypt = require('bcryptjs');
            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(`INSERT INTO users (email, password_hash, name, role)
                VALUES ('admin@apteki.ru', $1, 'Администратор', 'admin')
                ON CONFLICT (email) DO NOTHING`, [hash]);
            console.log('👑 Создан администратор: admin@apteki.ru / admin123');
        }
    } catch (err) {
        console.error('Ошибка инициализации БД:', err.message);
        process.exit(1);
    }
}

const db = {
    upsertPharmacy: async (p) => {
        await pool.query(`INSERT INTO pharmacies (id, source, name, address, phone, website, opening_hours, is_24h, lat, lon, rating, reviews_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO UPDATE SET
                name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
                website=EXCLUDED.website, opening_hours=EXCLUDED.opening_hours,
                is_24h=EXCLUDED.is_24h, lat=EXCLUDED.lat, lon=EXCLUDED.lon,
                rating=EXCLUDED.rating, reviews_count=EXCLUDED.reviews_count,
                updated_at=CURRENT_TIMESTAMP`,
            [p.id, p.source, p.name, p.address, p.phone, p.website, p.opening_hours, p.is_24h, p.lat, p.lon, p.rating, p.reviews_count]);
    },

    upsertMany: async (pharmacies) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const stmt = `INSERT INTO pharmacies (id, source, name, address, phone, website, opening_hours, is_24h, lat, lon, rating, reviews_count)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO UPDATE SET
                    name=EXCLUDED.name, address=EXCLUDED.address, phone=EXCLUDED.phone,
                    website=EXCLUDED.website, opening_hours=EXCLUDED.opening_hours,
                    is_24h=EXCLUDED.is_24h, lat=EXCLUDED.lat, lon=EXCLUDED.lon,
                    rating=EXCLUDED.rating, reviews_count=EXCLUDED.reviews_count,
                    updated_at=CURRENT_TIMESTAMP`;
            for (const p of pharmacies) {
                await client.query(stmt, [p.id, p.source, p.name, p.address, p.phone, p.website, p.opening_hours, p.is_24h, p.lat, p.lon, p.rating, p.reviews_count]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    },

    getPharmacy: async (id) => {
        const res = await pool.query(`SELECT * FROM pharmacies WHERE id = $1`, [id]);
        return res.rows[0] || null;
    },

    getOldestUpdate: async (ids) => {
    if (!ids || ids.length === 0) return null;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const res = await pool.query(
        `SELECT MIN(updated_at) as oldest FROM pharmacies WHERE id IN (${placeholders})`,
        ids
    );
    return res.rows[0]?.oldest ? new Date(res.rows[0].oldest) : null;
    },

    getPharmaciesInBounds: async (s, n, w, e) => {
    const res = await pool.query(`
        SELECT id, source, name, address, phone, website, 
               opening_hours, is_24h, lat, lon, rating, reviews_count
        FROM pharmacies
        WHERE lat BETWEEN $1 AND $2 
          AND lon BETWEEN $3 AND $4
        ORDER BY updated_at DESC 
        LIMIT 500  -- ← УВЕЛИЧИЛИ
    `, [s, n, w, e]);
    return res.rows;
    },

    searchPharmacies: async (pattern) => {
        const res = await pool.query(`SELECT id, source, name, address, phone, website, opening_hours, is_24h, lat, lon, rating, reviews_count
            FROM pharmacies WHERE name ILIKE $1 OR address ILIKE $1
            ORDER BY updated_at DESC LIMIT 50`, [`%${pattern}%`]);
        return res.rows;
    },

    createPharmacy: async (data) => {
        const id = 'manual_' + Date.now();
        const res = await pool.query(`INSERT INTO pharmacies (id, source, name, address, phone, website, opening_hours, is_24h, lat, lon)
            VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [id, data.name, data.address, data.phone, data.website, data.opening_hours, data.is_24h, data.lat, data.lon]);
        console.log(`➕ Админ добавил аптеку: ${data.name}`);
        return res.rows[0];
    },

    updatePharmacy: async (id, data) => {
        const res = await pool.query(`UPDATE pharmacies SET
            name = COALESCE($2, name), address = COALESCE($3, address),
            phone = COALESCE($4, phone), website = COALESCE($5, website),
            opening_hours = COALESCE($6, opening_hours), is_24h = COALESCE($7, is_24h),
            updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
            [id, data.name, data.address, data.phone, data.website, data.opening_hours, data.is_24h]);
        console.log(`✏️ Админ обновил аптеку: ${id}`);
        return res.rows[0];
    },

    deletePharmacy: async (id) => {
        await pool.query(`DELETE FROM pharmacies WHERE id = $1`, [id]);
        console.log(`🗑️ Админ удалил аптеку: ${id}`);
    },

    getAllPharmacies: async () => {
        const res = await pool.query(`SELECT * FROM pharmacies ORDER BY updated_at DESC`);
        return res.rows;
    },

    addMedicine: async (pharmacyId, name, price, inStock, description) => {
        const res = await pool.query(`INSERT INTO medicines (pharmacy_id, name, price, in_stock, description)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [pharmacyId, name, price, inStock !== false, description]);
        return res.rows[0];
    },

    updateMedicine: async (id, data) => {
        const res = await pool.query(`UPDATE medicines SET
            name = COALESCE($2, name), price = COALESCE($3, price),
            in_stock = COALESCE($4, in_stock), description = COALESCE($5, description),
            updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
            [id, data.name, data.price, data.in_stock, data.description]);
        return res.rows[0];
    },

    deleteMedicine: async (id) => {
        await pool.query(`DELETE FROM medicines WHERE id = $1`, [id]);
    },

    getMedicines: async (pharmacyId) => {
        const res = await pool.query(`SELECT * FROM medicines WHERE pharmacy_id = $1 ORDER BY name`, [pharmacyId]);
        return res.rows;
    },

    searchMedicine: async (medicineName) => {
        const res = await pool.query(`SELECT p.id as pharmacy_id, p.name as pharmacy_name, p.address, p.phone,
            p.opening_hours, p.is_24h, p.lat, p.lon, p.rating, p.source,
            m.id as medicine_id, m.name as medicine_name, m.price, m.in_stock
            FROM pharmacies p JOIN medicines m ON p.id = m.pharmacy_id
            WHERE m.name ILIKE $1 AND m.in_stock = TRUE ORDER BY m.price LIMIT 50`,
            [`%${medicineName}%`]);
        return res.rows;
    },

    addFavorite: async (pharmacyId, note, userId = null) => {
        await pool.query(`INSERT INTO favorites (pharmacy_id, user_id, note) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [pharmacyId, userId, note]);
    },

    removeFavorite: async (pharmacyId) => {
        await pool.query(`DELETE FROM favorites WHERE pharmacy_id = $1`, [pharmacyId]);
    },

    getFavorites: async () => {
        const res = await pool.query(`SELECT p.*, f.added_at, f.note FROM pharmacies p
            JOIN favorites f ON p.id = f.pharmacy_id ORDER BY f.added_at DESC`);
        return res.rows;
    },

    isFavorite: async (pharmacyId) => {
        const res = await pool.query(`SELECT 1 FROM favorites WHERE pharmacy_id = $1`, [pharmacyId]);
        return res.rows.length > 0;
    },

    getStats: async () => {
        const total = await pool.query(`SELECT COUNT(*) FROM pharmacies`);
        const osm = await pool.query(`SELECT COUNT(*) FROM pharmacies WHERE source='osm'`);
        const gis = await pool.query(`SELECT COUNT(*) FROM pharmacies WHERE source='2gis'`);
        const manual = await pool.query(`SELECT COUNT(*) FROM pharmacies WHERE source='manual'`);
        const h24 = await pool.query(`SELECT COUNT(*) FROM pharmacies WHERE is_24h=true`);
        const favs = await pool.query(`SELECT COUNT(*) FROM favorites`);
        const meds = await pool.query(`SELECT COUNT(*) FROM medicines`);
        const users = await pool.query(`SELECT COUNT(*) FROM users`);
        return {
            total: parseInt(total.rows[0].count),
            osm_count: parseInt(osm.rows[0].count),
            gis_count: parseInt(gis.rows[0].count),
            manual_count: parseInt(manual.rows[0].count),
            round_the_clock: parseInt(h24.rows[0].count),
            favorites_count: parseInt(favs.rows[0].count),
            medicines_count: parseInt(meds.rows[0].count),
            users_count: parseInt(users.rows[0].count)
        };
    },

    createUser: async (email, passwordHash, name) => {
        const res = await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, role`,
            [email, passwordHash, name]);
        return res.rows[0];
    },

    getUserByEmail: async (email) => {
        const res = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        return res.rows[0] || null;
    },

    getUserById: async (id) => {
        const res = await pool.query(`SELECT id, email, name, role FROM users WHERE id = $1`, [id]);
        return res.rows[0] || null;
    },

    isAdmin: async (userId) => {
        const res = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
        return res.rows[0]?.role === 'admin';
    }
};

module.exports = { initDatabase, db };