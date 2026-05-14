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
    'amazonaws.com','imgur.com','gravatar.com','unpkg.com','jsdelivr.net',
    'github.com','youtube.com','tiktok.com','telegram.org','whatsapp.com',
    'duckduckgo.com','bootstrapcdn.com','cdnjs.cloudflare.com',
]);

const TR_MAP = {'ç':'c','ğ':'g','ı':'i','İ':'i','ö':'o','ş':'s','ü':'u','Ç':'c','Ğ':'g','Ö':'o','Ş':'s','Ü':'u'};
const normalizeTr = s => s.replace(/[çğıİöşüÇĞÖŞÜ]/g, m => TR_MAP[m] || m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];
let uaIdx = 0;
const getHeaders = () => ({
    'User-Agent': UA_LIST[uaIdx++ % UA_LIST.length],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
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
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|js|css|woff|ico|mp4)$/i.test(lower)) return false;
    if (/example|placeholder|lorem|dummy|yourname|youremail|test@test|user@email|noreply|no-reply/i.test(lower)) return false;
    return true;
}

// Gizlenmiş emailleri çöz: "user [at] firma [dot] com" → "user@firma.com"
function decodeObfuscated(text) {
    return text
        .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[\(]at[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]dot[\]\)]\s*([a-zA-Z]{2,6})/gi, '$1@$2.$3')
        .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2')
        .replace(/([a-zA-Z0-9._%+\-]+)\s+@\s+([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2')
        .replace(/([a-zA-Z0-9._%+\-]+)\(at\)([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6})/gi, '$1@$2');
}

function extractEmails(text) {
    const decoded = decodeObfuscated(text);
    return [...new Set((decoded.match(EMAIL_RE) || []).map(e => e.toLowerCase()).filter(isValidEmail))];
}

// 7 farklı pattern — Apollo tarzı
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
            const resp = await axios.get(url, { headers: getHeaders(), timeout: 12000 });
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

// DuckDuckGo — bot dostu, CAPTCHA yok
async function searchDDG(query, location) {
    const items = [];
    const region = location === 'turkey' ? 'tr-tr' : 'us-en';
    const parseItems = ($) => {
        $('.result__body, .result').each((_, el) => {
            const title = $(el).find('.result__title, .result__a').first().text().trim();
            const snippet = $(el).find('.result__snippet').text().trim();
            let link = $(el).find('a.result__a').first().attr('href') || '';
            if (link.includes('duckduckgo.com')) {
                try {
                    const raw = link.startsWith('//') ? 'https:' + link : link;
                    const u = new URL(raw);
                    link = decodeURIComponent(u.searchParams.get('uddg') || u.searchParams.get('u') || link);
                } catch {}
            }
            if (title && link.startsWith('http')) items.push({ title, snippet, link });
        });
    };
    // GET ile dene — POST'tan daha güvenilir
    try {
        const resp = await axios.get(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${region}&ia=web`,
            { headers: { ...getHeaders(), 'Referer': 'https://duckduckgo.com/' }, timeout: 15000, maxRedirects: 5 }
        );
        parseItems(cheerio.load(resp.data));
    } catch {}
    return items;
}

async function searchBing(query, location) {
    const items = [];
    for (const first of [1, 11, 21, 31]) {
        try {
            let url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&count=10`;
            if (location === 'turkey') url += `&mkt=tr-TR&cc=TR&setlang=tr-TR`;
            const resp = await axios.get(url, { headers: getHeaders(), timeout: 12000 });
            const $ = cheerio.load(resp.data);
            // Bing CAPTCHA kontrolü
            if ($('#captcha').length || resp.data.includes('CaptchaAnswer')) return items;
            $('.b_algo').each((_, el) => {
                const title = $(el).find('h2').text().trim();
                const snippet = $(el).find('.b_caption p, .b_algoSlug').text().trim();
                const link = $(el).find('h2 a').attr('href') || '';
                if (title) items.push({ title, snippet, link });
            });
            await sleep(600);
        } catch {}
    }
    return items;
}

// ─── Website Scraping — Ana Silah ────────────────────────────────────────────

const SOCIAL_SKIP = ['linkedin.com','instagram.com','facebook.com','twitter.com',
    'x.com','youtube.com','tiktok.com','yahoo.com','bing.com','google.com',
    'duckduckgo.com','wikipedia.org','hurriyet.com','sabah.com','milliyet.com'];

async function scrapeWebsiteForEmails(originUrl) {
    const emails = new Set();
    const paths = ['', '/iletisim', '/contact', '/hakkimizda', '/about',
        '/bize-ulasin', '/iletisim.html', '/contact.html', '/iletisim.php'];

    for (const path of paths) {
        try {
            const resp = await axios.get(originUrl + path, {
                headers: getHeaders(),
                timeout: 8000,
                maxRedirects: 3,
            });
            const $ = cheerio.load(resp.data);

            // 1. mailto: linkleri — çoğu site buraya koyar (büyük hata kaçırıyorduk)
            $('a[href^="mailto:"]').each((_, el) => {
                const raw = $(el).attr('href').replace('mailto:', '').split('?')[0].trim().toLowerCase();
                if (isValidEmail(raw)) emails.add(raw);
            });

            // 2. Regex ile tüm kaynak + görünür metin
            const raw = resp.data;
            const pageText = $('body').text();
            [...extractEmails(raw), ...extractEmails(pageText)].forEach(e => emails.add(e));

            // 3. data-email ve data-mailto attribute'ları
            $('[data-email], [data-mailto], [data-mail]').each((_, el) => {
                const val = ($(el).attr('data-email') || $(el).attr('data-mailto') || $(el).attr('data-mail') || '').toLowerCase();
                if (isValidEmail(val)) emails.add(val);
            });

            if (emails.size > 0) break;
            await sleep(300);
        } catch {}
    }
    return [...emails];
}

// ─── MX Doğrulamalı Pattern Push ─────────────────────────────────────────────

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
        // 1. Snippet/title içindeki açık emailler
        for (const email of extractEmails(title + ' ' + snippet)) {
            if (!seenEmails.has(email)) {
                seenEmails.add(email);
                results.push({ email, title: title.trim().substring(0, 80), source: link || 'Search', snippet: snippet.substring(0, 150), tag });
            }
        }

        // 2. Website URL topla (sosyal medya/arama hariç)
        if (link && link.startsWith('http') && !SOCIAL_SKIP.some(d => link.includes(d))) {
            try { urlsToScrape.add(new URL(link).origin); } catch {}
        }

        // 3. LinkedIn → pattern tahmini
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
                patterns.forEach(e => seenEmails.add(e));
                validationPromises.push(
                    validateAndPush(patterns, `${parts[0]} @ ${companyRaw}`, link, tag, seenEmails, results)
                );
            }
        }
    }

    // Website contact sayfalarını tara — sorgu başına max 10
    for (const origin of [...urlsToScrape].slice(0, 10)) {
        try {
            const webEmails = await scrapeWebsiteForEmails(origin);
            const isTurkish = origin.endsWith('.tr') || origin.includes('.com.tr') || origin.includes('.net.tr');
            const label = isTurkish ? '[TR🇹🇷 Web]' : '[Web]';
            for (const email of webEmails) {
                if (!seenEmails.has(email)) {
                    seenEmails.add(email);
                    results.push({ email, title: `${label} ${origin}`, source: `${origin}/iletisim`, snippet: `Web sitesi iletişim sayfasından bulundu.`, tag });
                }
            }
        } catch {}
    }

    await Promise.all(validationPromises);
    return results;
}

// ─── Tek Sorgu — Yahoo + DDG + Bing Paralel ───────────────────────────────────

async function scrapeQuery(query, location, tag, globalSeenEmails) {
    try {
        const [yahooItems, ddgItems, bingItems] = await Promise.all([
            searchYahoo(query, location),
            searchDDG(query, location),
            searchBing(query, location),
        ]);
        return await processSearchItems([...yahooItems, ...ddgItems, ...bingItems], location, tag, globalSeenEmails);
    } catch (e) {
        console.error(`Query error [${tag}]:`, e.message);
        return [];
    }
}

// ─── Email-First Sorgu Şablonları ────────────────────────────────────────────
// Strateji: arama motoru snippet'larında email nadiren görünür.
// Email pattern'i SORGUNUN BAŞINA koyunca, search engine o metni içeren sayfaları getirir.

function buildQueries(tag, location) {
    if (location === 'turkey') {
        return [
            // Email-first, şehir adı ZORUNLU → yabancı sonuçları eliyor
            `"@gmail.com" "${tag}" "İstanbul"`,
            `"@gmail.com" "${tag}" "Türkiye"`,
            `"@hotmail.com" "${tag}" "İstanbul" OR "Ankara" OR "İzmir"`,
            // Instagram bio — Türkçe şehir adıyla kısıtla
            `site:instagram.com "${tag}" "türkiye" "@gmail.com" OR "@hotmail.com"`,
            // .tr sitelerini bul → iletişim sayfalarını tara (2 sorgu = 2x kapsam)
            `"${tag}" site:.tr`,
            `"${tag}" "iletişim" site:.tr`,
            // LinkedIn Türkiye → MX doğrulamalı pattern tahmin
            `site:tr.linkedin.com/in "${tag}"`,
        ];
    }
    return [
        `"@gmail.com" "${tag}"`,
        `"@outlook.com" "${tag}"`,
        `site:instagram.com "${tag}" "@gmail.com" OR "@outlook.com"`,
        `"${tag}" -site:facebook.com -site:twitter.com`,
        `"${tag}" site:.com email contact`,
        `site:linkedin.com/in "${tag}"`,
    ];
}

// ─── Ana Fonksiyon — 3 Paralel Worker ────────────────────────────────────────

async function findLeadsForTags(tags, location, onProgress) {
    const allLeads = [];
    const globalSeenEmails = new Set();
    const queries = tags.flatMap(tag => buildQueries(tag, location).map(q => ({ tag, q })));
    const total = queries.length;
    let taskIdx = 0;

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
            await sleep(600);
        }
    }

    await Promise.all([worker(), worker(), worker()]);

    if (onProgress) onProgress({ type: 'complete', count: allLeads.length });
    return allLeads;
}

module.exports = { findLeadsForTags };
