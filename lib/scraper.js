const axios = require('axios');
const cheerio = require('cheerio');
const emailValidator = require('deep-email-validator');

// ─── Sabitler ────────────────────────────────────────────────────────────────

const EMAIL_RE = /\b([a-zA-Z0-9][a-zA-Z0-9._%+\-]{0,63}@(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,6})\b/g;

const SKIP_DOMAINS = new Set([
    'example.com','sentry.io','schema.org','w3.org','jquery.com','cloudflare.com',
    'google.com','facebook.com','twitter.com','instagram.com','linkedin.com',
    'wix.com','wordpress.com','googleapis.com','gstatic.com','microsoft.com',
    'apple.com','adobe.com','fontawesome.com','yahoo.com','bing.com','yandex.com',
    'amazonaws.com','pixel.com','cdn.com','imgur.com','gravatar.com','unpkg.com',
    'bootstrapcdn.com','cdnjs.cloudflare.com','jsdelivr.net','github.com',
    'githubusercontent.com','youtube.com','tiktok.com','telegram.org','whatsapp.com',
]);

const TR_MAP = {
    'ç':'c','ğ':'g','ı':'i','İ':'i','ö':'o','ş':'s','ü':'u',
    'Ç':'c','Ğ':'g','Ö':'o','Ş':'s','Ü':'u',
};
const normalizeTr = s => s.replace(/[çğıİöşüÇĞÖŞÜ]/g, m => TR_MAP[m] || m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];
let uaIdx = 0;
const getHeaders = (lang = 'tr') => ({
    'User-Agent': UA_LIST[uaIdx++ % UA_LIST.length],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': lang === 'tr' ? 'tr-TR,tr;q=0.9,en;q=0.7' : 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
});

// ─── Email Yardımcıları ───────────────────────────────────────────────────────

function isValidEmail(email) {
    const lower = email.toLowerCase();
    const atIdx = lower.lastIndexOf('@');
    if (atIdx < 2) return false;
    const local = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx + 1);
    if (!local || !domain || local.length < 2 || local.length > 64) return false;
    if (!domain.includes('.') || domain.length < 4) return false;
    if (SKIP_DOMAINS.has(domain)) return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|js|css|woff|ico|mp4|avi|mov)$/i.test(lower)) return false;
    if (/example|placeholder|lorem|dummy|yourname|youremail|test@test|user@email|noreply|no-reply/i.test(lower)) return false;
    return true;
}

// Gizlenmiş emailleri çözer: "info [at] firma [dot] com" → "info@firma.com"
function decodeObfuscated(text) {
    return text
        .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[\(]at[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]dot[\]\)]\s*([a-zA-Z]{2,6})/gi, '$1@$2.$3')
        .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2')
        .replace(/([a-zA-Z0-9._%+\-]+)\s+@\s+([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2')
        .replace(/([a-zA-Z0-9._%+\-]+)\(at\)([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2');
}

function extractEmails(text) {
    const decoded = decodeObfuscated(text);
    const found = decoded.match(EMAIL_RE) || [];
    return [...new Set(found.map(e => e.toLowerCase()).filter(isValidEmail))];
}

// Apollo tarzı 7 farklı email pattern
function generateEmailPatterns(first, last, domain) {
    const f = normalizeTr(first).toLowerCase().replace(/[^a-z0-9]/g, '');
    const l = normalizeTr(last).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!f || !l || f.length < 2 || l.length < 2) return [];
    return [...new Set([
        `${f}.${l}@${domain}`,
        `${f[0]}.${l}@${domain}`,
        `${f[0]}${l}@${domain}`,
        `${f}@${domain}`,
        `${f}${l}@${domain}`,
        `${f}_${l}@${domain}`,
        `${f}.${l[0]}@${domain}`,
    ])];
}

// Türk şirketi adından olası domainler (.com.tr öncelikli)
function getCompanyDomains(companyName) {
    const norm = normalizeTr(companyName)
        .toLowerCase()
        .replace(/\b(ltd|sti|sirketi|şirketi|aş|as|anonim|kurumu|ozel|hizmetleri|sanayi|ticaret|grup|holding|group|inc|llc|corp|gmbh|ve|&)\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim()
        .replace(/\s+/g, '');
    if (!norm || norm.length < 2) return [];
    return [`${norm}.com.tr`, `${norm}.com`, `${norm}.net.tr`, `${norm}.net`];
}

// ─── Arama Motorları ──────────────────────────────────────────────────────────

async function searchYahoo(query, location) {
    const items = [];
    for (const b of [1, 11, 21, 31, 41]) {
        try {
            let url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&b=${b}`;
            if (location === 'turkey') url += `&vl=lang_tr&vc=tr&vd=tr`;
            const resp = await axios.get(url, { headers: getHeaders('tr'), timeout: 12000 });
            const $ = cheerio.load(resp.data);
            $('.algo-sr, .Sr').each((_, el) => {
                const title = $(el).find('h3.title, .tz-title, h3').first().text().trim();
                const snippet = $(el).find('.compText, .compTitle').text().trim() || $(el).text().substring(0, 300);
                const link = $(el).find('a').first().attr('href') || '';
                if (title) items.push({ title, snippet, link });
            });
            await sleep(700);
        } catch {}
    }
    return items;
}

async function searchBing(query, location) {
    const items = [];
    for (const first of [1, 11, 21, 31, 41]) {
        try {
            let url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&count=10`;
            if (location === 'turkey') url += `&mkt=tr-TR&cc=TR&setlang=tr-TR`;
            const resp = await axios.get(url, { headers: getHeaders('tr'), timeout: 12000 });
            const $ = cheerio.load(resp.data);
            $('.b_algo').each((_, el) => {
                const title = $(el).find('h2').text().trim();
                const snippet = $(el).find('.b_caption p, .b_algoSlug, .b_dList li').text().trim();
                const link = $(el).find('h2 a').attr('href') || '';
                if (title) items.push({ title, snippet, link });
            });
            await sleep(600);
        } catch {}
    }
    return items;
}

async function searchGoogle(query, location) {
    const items = [];
    for (const start of [0, 10, 20, 30]) {
        try {
            let url = `https://www.google.com/search?q=${encodeURIComponent(query)}&start=${start}&num=10`;
            if (location === 'turkey') url += `&gl=tr&hl=tr&cr=countryTR`;
            const resp = await axios.get(url, {
                headers: {
                    ...getHeaders('tr'),
                    'Referer': 'https://www.google.com/',
                },
                timeout: 12000,
            });
            const $ = cheerio.load(resp.data);
            // Google selector'ları zaman zaman değişir, birden fazla dene
            $('div.g, .tF2Cxc, .MjjYud .g').each((_, el) => {
                const title = $(el).find('h3').first().text().trim();
                const snippet = $(el).find('.VwiC3b, .yXK7lf, span[data-content-feature]').text().trim()
                    || $(el).find('span').filter((_, s) => $(s).text().length > 30).first().text().trim();
                const link = $(el).find('a[href^="http"]').first().attr('href') || '';
                if (title && !link.includes('google.com') && !link.includes('accounts.google')) {
                    items.push({ title, snippet, link });
                }
            });
            await sleep(2000); // Google için daha uzun bekleme
        } catch {}
    }
    return items;
}

// ─── Website İletişim Sayfası Taraması ───────────────────────────────────────

const SOCIAL_SKIP = ['linkedin.com','instagram.com','facebook.com','twitter.com',
    'x.com','youtube.com','tiktok.com','yahoo.com','bing.com','google.com','wikipedia.org'];

async function scrapeWebsiteForEmails(originUrl) {
    const emails = new Set();
    const paths = ['/iletisim', '/contact', '/hakkimizda', '/about', '/bize-ulasin',
        '/iletisim.html', '/contact.html', '/hakkimizda.html', '/iletisim.php', ''];
    for (const path of paths) {
        try {
            const resp = await axios.get(originUrl + path, {
                headers: getHeaders('tr'),
                timeout: 7000,
                maxRedirects: 3,
            });
            // Hem HTML kaynak kodu hem de görünür metin içinde ara
            const raw = resp.data;
            const $ = cheerio.load(raw);
            const pageText = $('body').text();
            [...extractEmails(raw), ...extractEmails(pageText)].forEach(e => emails.add(e));
            if (emails.size > 0) break;
            await sleep(300);
        } catch {}
    }
    return [...emails];
}

// ─── MX Doğrulamalı Pattern Pusher ───────────────────────────────────────────

async function validateAndPush(patterns, displayTitle, link, tag, seenEmails, results) {
    try {
        const v = await emailValidator.validate({
            email: patterns[0],
            validateRegex: true,
            validateMx: true,
            validateTypo: false,
            validateDisposable: true,
            validateSMTP: false,
        });
        const mxOk = v.valid || (v.validators && v.validators.mx && v.validators.mx.valid);
        if (!mxOk) return;

        for (const email of patterns) {
            if (!seenEmails.has(email)) {
                seenEmails.add(email);
                results.push({
                    email,
                    title: `[MX✅] ${displayTitle}`,
                    source: link || 'LinkedIn Pattern Guesser',
                    snippet: `Domain MX kaydı doğrulandı. Pattern tahmini.`,
                    tag,
                });
            }
        }
    } catch {}
}

// ─── Arama Sonuçlarını İşle ───────────────────────────────────────────────────

async function processSearchItems(items, location, tag, seenEmails) {
    const results = [];
    const urlsToScrape = new Set();
    const validationPromises = [];

    for (const { title, snippet, link } of items) {
        // 1. Snippet ve title'daki açık emailler
        for (const email of extractEmails(title + ' ' + snippet)) {
            if (!seenEmails.has(email)) {
                seenEmails.add(email);
                results.push({ email, title: title.trim().substring(0, 80), source: link || 'Search', snippet: snippet.substring(0, 150), tag });
            }
        }

        // 2. Website iletişim sayfası için URL topla
        if (link && link.startsWith('http') && !SOCIAL_SKIP.some(d => link.includes(d))) {
            try { urlsToScrape.add(new URL(link).origin); } catch {}
        }

        // 3. LinkedIn profili → isim + şirket → çoklu pattern
        if (link && link.includes('linkedin.com/in') && title.includes('-')) {
            const parts = title.split('-').map(p => p.trim());
            if (parts.length < 2) continue;
            const nameParts = parts[0].split(' ').filter(Boolean);
            if (nameParts.length < 2) continue;

            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];
            const companyRaw = (parts.length >= 3 ? parts[2] : parts[1]).split('|')[0].trim();
            const domains = getCompanyDomains(companyRaw);
            if (!domains.length) continue;

            for (const domain of domains.slice(0, 2)) {
                const patterns = generateEmailPatterns(firstName, lastName, domain);
                if (!patterns.length) continue;
                patterns.forEach(e => seenEmails.add(e)); // Race condition önleme
                validationPromises.push(
                    validateAndPush(patterns, `${parts[0]} @ ${companyRaw}`, link, tag, seenEmails, results)
                );
            }
        }
    }

    // Website iletişim sayfalarını tara (sorgu başına max 5)
    for (const origin of [...urlsToScrape].slice(0, 5)) {
        try {
            const webEmails = await scrapeWebsiteForEmails(origin);
            for (const email of webEmails) {
                if (!seenEmails.has(email)) {
                    seenEmails.add(email);
                    results.push({ email, title: `[Web] ${origin}`, source: `${origin}/iletisim`, snippet: `Web sitesi iletişim sayfasından bulundu.`, tag });
                }
            }
        } catch {}
    }

    await Promise.all(validationPromises);
    return results;
}

// ─── Tek Sorgu İşleme ─────────────────────────────────────────────────────────

async function scrapeQuery(query, location, tag, globalSeenEmails) {
    try {
        // Yahoo + Bing + Google paralel çalışır
        const [yahooItems, bingItems, googleItems] = await Promise.all([
            searchYahoo(query, location),
            searchBing(query, location),
            searchGoogle(query, location),
        ]);
        const allItems = [...yahooItems, ...bingItems, ...googleItems];
        return await processSearchItems(allItems, location, tag, globalSeenEmails);
    } catch (e) {
        console.error(`Query error [${tag}]:`, e.message);
        return [];
    }
}

// ─── Sorgu Şablonları ─────────────────────────────────────────────────────────

function buildQueries(tag, location) {
    if (location === 'turkey') {
        return [
            // Snippet'ta direkt email
            `"${tag}" Türkiye "iletişim" "@"`,
            // LinkedIn profil → pattern tahmini
            `site:tr.linkedin.com/in "${tag}"`,
            // Instagram bio'ları — altın maden, birçok Türk işletme email yazar
            `site:instagram.com "${tag}" ("istanbul" OR "ankara" OR "türkiye") "@gmail.com" OR "@hotmail.com"`,
            // .tr domain'li siteler, email içeren sayfalar
            `"${tag}" site:.tr "e-posta" OR "email"`,
            // Kişisel emailler, forum/haber sitelerinde
            `"${tag}" Türkiye "@gmail.com" OR "@hotmail.com" OR "@outlook.com" -site:linkedin.com`,
            // PDF ve belgeler (genelde gerçek emailler içerir)
            `"${tag}" Türkiye "email" filetype:pdf OR filetype:doc`,
        ];
    }
    return [
        `"${tag}" "contact" "email" OR "@"`,
        `site:linkedin.com/in "${tag}"`,
        `site:instagram.com "${tag}" "@gmail.com" OR "@outlook.com"`,
        `"${tag}" company email -site:facebook.com -site:twitter.com`,
        `"${tag}" "@gmail.com" OR "@outlook.com" OR "@yahoo.com"`,
        `"${tag}" "email" filetype:pdf OR filetype:doc`,
    ];
}

// ─── Ana Fonksiyon (3 eşzamanlı worker) ──────────────────────────────────────

async function findLeadsForTags(tags, location, onProgress) {
    const allLeads = [];
    const globalSeenEmails = new Set();
    const queries = tags.flatMap(tag => buildQueries(tag, location).map(q => ({ tag, q })));

    let taskIdx = 0;
    const total = queries.length;

    async function worker() {
        while (taskIdx < total) {
            const idx = taskIdx++;
            const { tag, q } = queries[idx];

            if (onProgress) {
                onProgress({ type: 'status', message: `Tarama (${idx + 1}/${total}) [${tag}]: ${q.substring(0, 85)}` });
            }

            const leads = await scrapeQuery(q, location, tag, globalSeenEmails);

            for (const lead of leads) {
                allLeads.push(lead);
                if (onProgress) onProgress({ type: 'lead', data: lead });
            }

            await sleep(800); // Worker başına minimum bekleme
        }
    }

    // 3 worker paralel çalışır → 3x hız
    await Promise.all([worker(), worker(), worker()]);

    if (onProgress) onProgress({ type: 'complete', count: allLeads.length });
    return allLeads;
}

module.exports = { findLeadsForTags };
