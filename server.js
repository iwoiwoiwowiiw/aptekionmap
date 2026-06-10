const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDatabase, db } = require('./database');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8888;
const JWT_SECRET = 'super_secret_key_for_apteki_project_2026';
const GIS_2GIS_KEY = '19c03829-08f1-440d-9c77-44204d015bed';

const memoryCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCacheKey(s, w, n, e) {
    const round = (v) => Math.round(v * 100) / 100;
    return `${round(s)}_${round(w)}_${round(n)}_${round(e)}`;
}

function getCached(key) {
    const cached = memoryCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.time > CACHE_TTL) {
        memoryCache.delete(key);
        return null;
    }
    return cached.data;
}

function setCache(key, data) {
    memoryCache.set(key, { time: Date.now(), data });
    if (memoryCache.size > 200) {
        const firstKey = memoryCache.keys().next().value;
        memoryCache.delete(firstKey);
    }
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    try {
        req.userId = jwt.verify(token, JWT_SECRET).id;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Неверный токен' });
    }
}

async function adminMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!await db.isAdmin(decoded.id)) return res.status(403).json({ error: 'Требуются права администратора' });
        req.userId = decoded.id;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Неверный токен' });
    }
}

async function fetchFrom2GIS(s, w, n, e) {
    const centerLat = (s + n) / 2;
    const centerLon = (w + e) / 2;
    
    let radius = Math.round(Math.max(n - s, e - w) * 111000);
    radius = Math.max(500, Math.min(radius, 50000));
    
    const allItems = [];
    let page = 1;
    const maxPages = 10;
    
    try {
        while (page <= maxPages) {
            const url = `https://catalog.api.2gis.com/3.0/items?q=аптека&point=${centerLon},${centerLat}&radius=${radius}&key=${GIS_2GIS_KEY}&fields=items.point,items.address,items.phone,items.schedule,items.rating,items.review_count,items.website_url&page=${page}&size=50`;
            
            const resp = await fetch(url);
            const data = await resp.json();
            
            if (!data.result || !data.result.items || data.result.items.length === 0) {
                break;
            }
            
            allItems.push(...data.result.items);
            
            const total = data.result.total || 0;
            
            if (total > 0 && allItems.length >= total) {
                break;
            }
            
            page++;
        }
        
        if (allItems.length === 0) return [];
        
        console.log(`✅ 2GIS: получено ${allItems.length} аптек (${page} стр.)`);
        
        return allItems.map(item => ({
            id: '2gis_' + item.id,
            source: '2gis',
            name: item.name || 'Аптека',
            address: item.address_name || item.address?.formatted_name || 'Адрес не указан',
            phone: item.phone?.[0]?.value || null,
            website: item.website_url || null,
            opening_hours: item.schedule?.description || null,
            is_24h: item.schedule?.is_24x7 || false,
            lat: item.point?.lat,
            lon: item.point?.lon,
            rating: item.rating || null,
            reviews_count: item.review_count || 0
        })).filter(p => p.lat && p.lon);
    } catch (err) {
        console.error('❌ 2GIS error:', err.message);
        return [];
    }
}

async function fetchFromOverpass(s, w, n, e, signal) {
    const query = `[out:json][timeout:15];(node["amenity"="pharmacy"](${s},${w},${n},${e});way["amenity"="pharmacy"](${s},${w},${n},${e}););out center tags;`;
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
        signal
    });
    if (!(resp.headers.get('content-type') || '').includes('application/json')) {
        throw new Error(`Overpass API: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return (data.elements || []).map(el => ({
        id: 'osm_' + el.id,
        source: 'osm',
        name: el.tags?.name || 'Аптека',
        address: el.tags?.['addr:street'] ? el.tags['addr:street'] + (el.tags['addr:housenumber'] ? ', ' + el.tags['addr:housenumber'] : '') : (el.tags?.['addr:full'] || 'Адрес не указан'),
        phone: el.tags?.phone || el.tags['contact:phone'] || null,
        website: el.tags?.website || el.tags['contact:website'] || null,
        opening_hours: el.tags?.opening_hours || null,
        is_24h: /24\/7|Mo-Su 00:00-24:00/i.test(el.tags?.opening_hours || ''),
        lat: el.lat || el.center?.lat,
        lon: el.lon || el.center?.lon,
        rating: null,
        reviews_count: null
    })).filter(p => p.lat && p.lon);
}

async function preloadNeighbors(s, w, n, e) {
    const offset = 0.02;
    const neighbors = [
        [s - offset, w - offset, n, e],
        [s - offset, w, n, e + offset],
        [s, w - offset, n + offset, e],
        [s, w, n + offset, e + offset],
    ];
    for (const [ns, nw, nn, ne] of neighbors) {
        const key = getCacheKey(ns, nw, nn, ne);
        if (!getCached(key)) {
            db.getPharmaciesInBounds(ns, nn, nw, ne).then(data => {
                if (data.length > 0) setCache(key, data);
            }).catch(() => {});
        }
    }
}

app.get('/api/pharmacies', async (req, res) => {
    const startTime = Date.now();
    try {
        const { south, west, north, east, forceRefresh } = req.query;
        if (!south || !west || !north || !east) {
            return res.status(400).json({ error: 'Укажите границы области' });
        }

        const s = parseFloat(south), w = parseFloat(west);
        const n = parseFloat(north), e = parseFloat(east);
        const cacheKey = getCacheKey(s, w, n, e);

        if (!forceRefresh) {
            const cached = getCached(cacheKey);
            if (cached) {
                console.log(`⚡ Кэш: ${cached.length} аптек за ${Date.now() - startTime}ms`);
                return res.json({ source: 'memory-cache', count: cached.length, pharmacies: cached });
            }
        }

        const dbPharmacies = await db.getPharmaciesInBounds(s, n, w, e);
        console.log(`💾 БД: ${dbPharmacies.length} аптек`);

        if (dbPharmacies.length > 0) {
            setCache(cacheKey, dbPharmacies);
            res.json({ source: 'db', count: dbPharmacies.length, pharmacies: dbPharmacies });
            
            const cacheAge = getCached(cacheKey)?.time || 0;
            const isOld = Date.now() - cacheAge > 60 * 60 * 1000; 
            
            if (forceRefresh || isOld) {
                setTimeout(async () => {
                    try {
                        const pharmacies = [];
                        const gisData = await fetchFrom2GIS(s, w, n, e);
                        pharmacies.push(...gisData);
                        
                        if (pharmacies.length > 0) {
                            await db.upsertMany(pharmacies);
                            const merged = [...dbPharmacies];
                            const seen = new Set(merged.map(p => p.id));
                            for (const p of pharmacies) {
                                if (!seen.has(p.id)) {
                                    merged.push(p);
                                    seen.add(p.id);
                                }
                            }
                            setCache(cacheKey, merged);
                            console.log(`🔄 Обновлено: +${pharmacies.length} из 2GIS`);
                        }
                    } catch (err) {
                        console.error('Фоновое обновление:', err.message);
                    }
                }, 100);
            }
        } else {
            const pharmacies = [];
            try {
                const gisData = await fetchFrom2GIS(s, w, n, e);
                pharmacies.push(...gisData);
            } catch (err) {}

            if (pharmacies.length > 0) {
                await db.upsertMany(pharmacies);
                setCache(cacheKey, pharmacies);
            }

            res.json({ source: 'live', count: pharmacies.length, pharmacies });
        }

    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ pharmacies: [] });
    res.json({ pharmacies: await db.searchPharmacies(q) });
});

app.get('/api/pharmacy/:id', async (req, res) => {
    const p = await db.getPharmacy(req.params.id);
    if (!p) return res.status(404).json({ error: 'Не найдено' });
    res.json({ ...p, isFavorite: await db.isFavorite(p.id), medicines: await db.getMedicines(p.id) });
});

app.get('/api/stats', async (req, res) => res.json(await db.getStats()));

app.get('/api/search-medicine', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });
    res.json({ results: await db.searchMedicine(q) });
});

app.get('/api/medicines/:pharmacyId', async (req, res) => {
    res.json({ medicines: await db.getMedicines(req.params.pharmacyId) });
});

app.post('/api/favorites', async (req, res) => {
    const { pharmacyId, note } = req.body;
    if (!pharmacyId) return res.status(400).json({ error: 'Нет ID' });
    await db.addFavorite(pharmacyId, note);
    res.json({ success: true });
});

app.delete('/api/favorites/:id', async (req, res) => {
    await db.removeFavorite(req.params.id);
    res.json({ success: true });
});

app.get('/api/favorites', async (req, res) => res.json({ favorites: await db.getFavorites() }));
app.get('/api/favorites/check/:id', async (req, res) => res.json({ isFavorite: await db.isFavorite(req.params.id) }));

app.post('/api/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
        if (await db.getUserByEmail(email)) return res.status(400).json({ error: 'Email уже используется' });
        const user = await db.createUser(email, await bcrypt.hash(password, 10), name);
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await db.getUserByEmail(email);
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(400).json({ error: 'Неверный email или пароль' });
        }
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

app.get('/api/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    try {
        const user = await db.getUserById(jwt.verify(token, JWT_SECRET).id);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        res.json({ user });
    } catch (err) {
        res.status(401).json({ error: 'Неверный токен' });
    }
});

app.post('/api/admin/pharmacies', adminMiddleware, async (req, res) => {
    try {
        const data = req.body;
        if (!data.lat || !data.lon || !data.name) return res.status(400).json({ error: 'lat, lon и name обязательны' });
        const pharmacy = await db.createPharmacy(data);
        memoryCache.clear();
        res.json({ success: true, pharmacy });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/pharmacies/:id', adminMiddleware, async (req, res) => {
    try {
        const pharmacy = await db.updatePharmacy(req.params.id, req.body);
        memoryCache.clear();
        res.json({ success: true, pharmacy });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/pharmacies/:id', adminMiddleware, async (req, res) => {
    try {
        await db.deletePharmacy(req.params.id);
        memoryCache.clear();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/pharmacies', adminMiddleware, async (req, res) => {
    res.json({ pharmacies: await db.getAllPharmacies() });
});

app.post('/api/admin/medicines', adminMiddleware, async (req, res) => {
    try {
        const { pharmacyId, name, price, inStock, description } = req.body;
        if (!pharmacyId || !name) return res.status(400).json({ error: 'pharmacyId и name обязательны' });
        const medicine = await db.addMedicine(pharmacyId, name, price, inStock, description);
        console.log(`💊 Админ добавил лекарство: ${name} в аптеку ${pharmacyId}`);
        res.json({ success: true, medicine });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/medicines/:id', adminMiddleware, async (req, res) => {
    try {
        res.json({ success: true, medicine: await db.updateMedicine(req.params.id, req.body) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/medicines/:id', adminMiddleware, async (req, res) => {
    try {
        await db.deleteMedicine(req.params.id);
        console.log(`🗑️ Админ удалил лекарство: ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/medicines/import', adminMiddleware, async (req, res) => {
    try {
        const { pharmacyId, medicines } = req.body;
        if (!pharmacyId || !medicines || !Array.isArray(medicines)) {
            return res.status(400).json({ error: 'pharmacyId и medicines обязательны' });
        }
        const imported = [], errors = [];
        for (let i = 0; i < medicines.length; i++) {
            const med = medicines[i];
            if (!med.name || med.name.trim() === '') {
                errors.push(`Строка ${i + 1}: название пустое`);
                continue;
            }
            try {
                imported.push(await db.addMedicine(pharmacyId, med.name.trim(), med.price ? parseFloat(med.price) : null, med.in_stock !== false, med.description || null));
            } catch (e) {
                errors.push(`Строка ${i + 1}: ${e.message}`);
            }
        }
        console.log(`💊 Админ импортировал ${imported.length} лекарств в аптеку ${pharmacyId}`);
        res.json({ success: true, imported: imported.length, errors, medicines: imported });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/medicines/:pharmacyId/export', adminMiddleware, async (req, res) => {
    try {
        const medicines = await db.getMedicines(req.params.pharmacyId);
        let csv = 'Название,Цена,В наличии,Описание\n';
        medicines.forEach(m => {
            const name = `"${(m.name || '').replace(/"/g, '""')}"`;
            const desc = `"${(m.description || '').replace(/"/g, '""')}"`;
            csv += `${name},${m.price || ''},${m.in_stock ? 'Да' : 'Нет'},${desc}\n`;
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=medicines_${req.params.pharmacyId}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

console.log(`Используем порт: ${PORT}`);
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`💊 АптекиНаКарте запущен: http://localhost:${PORT}`);
        console.log(`👑 Админ: admin@apteki.ru / admin123`);
    });
}).catch(err => {
    console.error('Ошибка инициализации БД:', err);
    process.exit(1);
});
