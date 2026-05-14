const axios = require('axios');
const cheerio = require('cheerio');
const emailValidator = require('deep-email-validator');

const EMAIL_RE = /\b([a-zA-Z0-9][a-zA-Z0-9._%+\-]{0,63}@(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,6})\b/g;

const SKIP_DOMAINS = new Set([
    'example.com','sentry.io','schema.org','w3.org','jquery.com','cloudflare.com',
    'google.com','facebook.com','twitter.com','instagram.com','linkedin.com',
    'wix.com','wordpress.com','googleapis.com','gstatic.com','microsoft.com',
    'apple.com','adobe.com','fontawesome.com','yahoo.com','bing.com','yandex.com',
    'amazonaws.com','pixel.com','cdn.com','static.com','imgur.com','gravatar.com',
]);

const TR_MAP = {
    'ç':'c','ğ':'g','ı':'i','İ':'i','ö':'o','ş':'s','ü':'u',
    'Ç':'c','Ğ':'g','Ö':'o','Ş':'s','Ü':'u',
};
const normalizeTr = s => s.replace(/[çğıİöşüÇĞÖŞÜ]/g, m => TR_MAP[m] || m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
};

function isValidEmail(email) {
    const lower = email.toLowerCase();
    const atIdx = lower.lastIndexOf('@');
    if (atIdx < 2) return false;
    const local = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx + 1);
    if (!local || !domain || local.length < 2 || local.length > 64) return false;
    if (!domain.includes('.') || domain.length < 4) return false;
    if (SKIP_DOMAINS.has(domain)) return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|js|css|woff|ico|mp4|avi)$/i.test(lower)) return false;
    if (/example|placeholder|lorem|dummy|yourname|youremail|test@test|user@email/i.test(lower)) return false;
    return true;
}

function extractEmails(text) {
    const found = text.match(EMAIL_RE) || [];
    return [...new Set(found.map(e => e.toLowerCase()).filter(isValidEmail))];
}

// 7 farklı email pattern dener - Apollo'nun yaptığı gibi
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

// Türkçe şirket adından olası domainleri üretir (.com.tr öncelikli)
function getCompanyDomains(companyName) {
    const norm = normalizeTr(companyName)
        .toLowerCase()
        .replace(/\b(ltd|sti|sirketi|şirketi|aş|as|anonim|kurumu|ozel|hizmetleri|sanayi|ticaret|grup|holding|group|inc|llc|corp|gmbh|ve|&)\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .trim()
        .replace(/\s+/g, '');
    if (!norm || norm.length < 2) return [];
    return [
        `${norm}.com.tr`,
        `${norm}.com`,
        `${norm}.net.tr`,
        `${norm}.net`,
    ];
}

async function searchYahoo(query, location) {
    const items = [];
    for (const b of [1, 11, 21, 31]) {
        try {
            let url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&b=${b}`;
            if (location === 'turkey') url += `&vl=lang_tr&vc=tr&vd=tr`;
            const resp = await axios.get(url, { headers: HEADERS, timeout: 10000 });
            const $ = cheerio.load(resp.data);
            $('.algo-sr, .Sr').each((_, el) => {
                const title = $(el).find('h3.title, .tz-title, h3').first().text().trim();
                const snippet = $(el).find('.compText, .compTitle').text().trim() || $(el).text().substring(0, 200);
                const link = $(el).find('a').first().attr('href') || '';
                if (title) items.push({ title, snippet, link });
            });
            await sleep(800);
        } catch {}
    }
    return items;
}

async function searchBing(query, location) {
    const items = [];
    for (const first of [1, 11, 21, 31]) {
        try {
            let url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&count=10`;
            if (location === 'turkey') url += `&mkt=tr-TR&cc=TR&setlang=tr-TR`;
            const lang = location === 'turkey' ? 'tr-TR,tr;q=0.9' : 'en-US,en;q=0.9';
            const resp = await axios.get(url, { headers: { ...HEADERS, 'Accept-Language': lang }, timeout: 10000 });
            const $ = cheerio.load(resp.data);
            $('.b_algo').each((_, el) => {
                const title = $(el).find('h2').text().trim();
                const snippet = $(el).find('.b_caption p, .b_algoSlug, .b_dList li').text().trim();
                const link = $(el).find('h2 a').attr('href') || '';
                if (title) items.push({ title, snippet, link });
            });
            await sleep(700);
        } catch {}
    }
    return items;
}

// Şirket web sitesinin iletişim/hakkında sayfalarını ziyaret edip email toplar
async function scrapeWebsiteForEmails(originUrl) {
    const emails = new Set();
    const paths = ['/iletisim', '/contact', '/hakkimizda', '/about', '/bize-ulasin', '/iletisim.html', '/contact.html', ''];
    for (const path of paths) {
        try {
            const resp = await axios.get(originUrl + path, {
                headers: HEADERS,
                timeout: 6000,
                maxRedirects: 3,
            });
            extractEmails(resp.data).forEach(e => emails.add(e));
            if (emails.size > 0) break;
            await sleep(400);
        } catch {}
    }
    return [...emails];
}

const SOCIAL_SKIP = ['linkedin.com', 'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'yahoo.com', 'bing.com', 'google.com'];

// MX kaydı doğrulandıysa tüm pattern'leri ekler
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

        // 2. İletişim sayfası için URL topla (sosyal medya/arama hariç)
        if (link && link.startsWith('http') && !SOCIAL_SKIP.some(d => link.includes(d))) {
            try {
                urlsToScrape.add(new URL(link).origin);
            } catch {}
        }

        // 3. LinkedIn profili → isim + şirket → çoklu pattern tahmini
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

            // İlk 2 olası domain için tüm pattern'leri dene
            for (const domain of domains.slice(0, 2)) {
                const patterns = generateEmailPatterns(firstName, lastName, domain);
                if (!patterns.length) continue;
                // Önceden rezerve et - race condition önleme
                patterns.forEach(e => seenEmails.add(e));
                validationPromises.push(
                    validateAndPush(patterns, `${parts[0]} @ ${companyRaw}`, link, tag, seenEmails, results)
                );
            }
        }
    }

    // Web sitesi iletişim sayfalarını tara (query başına max 3)
    for (const origin of [...urlsToScrape].slice(0, 3)) {
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

async function scrapeQuery(query, location, tag, globalSeenEmails) {
    try {
        const [yahooItems, bingItems] = await Promise.all([
            searchYahoo(query, location),
            searchBing(query, location),
        ]);
        return await processSearchItems([...yahooItems, ...bingItems], location, tag, globalSeenEmails);
    } catch (e) {
        console.error(`Query error [${tag}]:`, e.message);
        return [];
    }
}

function buildQueries(tag, location) {
    if (location === 'turkey') {
        return [
            `"${tag}" Türkiye "iletişim" "@"`,
            `"${tag}" site:tr.linkedin.com/in`,
            `"${tag}" Türkiye "@gmail.com" OR "@hotmail.com" OR "@outlook.com"`,
            `"${tag}" site:.tr email OR "e-posta"`,
        ];
    }
    return [
        `"${tag}" "contact" "email" OR "@"`,
        `"${tag}" site:linkedin.com/in`,
        `"${tag}" "@gmail.com" OR "@outlook.com" OR "@yahoo.com"`,
        `"${tag}" company email -site:facebook.com -site:twitter.com`,
    ];
}

async function findLeadsForTags(tags, location, onProgress) {
    const allLeads = [];
    const globalSeenEmails = new Set();

    const queries = tags.flatMap(tag => buildQueries(tag, location).map(q => ({ tag, q })));

    for (let i = 0; i < queries.length; i++) {
        const { tag, q } = queries[i];

        if (onProgress) {
            onProgress({ type: 'status', message: `Tarama (${i + 1}/${queries.length}) [${tag}]: ${q.substring(0, 90)}` });
        }

        const leads = await scrapeQuery(q, location, tag, globalSeenEmails);

        for (const lead of leads) {
            allLeads.push(lead);
            if (onProgress) onProgress({ type: 'lead', data: lead });
        }

        if (i < queries.length - 1) await sleep(1800);
    }

    if (onProgress) onProgress({ type: 'complete', count: allLeads.length });
    return allLeads;
}

module.exports = { findLeadsForTags };
