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

// Devlet/kamu kurumu domain'leri — tamamen bloke
const GOVT_RE = /\.(gov|bel|pol|tsk|k12|edu|meb|metu|boun|itu|hacettepe|ankara\.edu|ege\.edu)\.tr$/i;

function isValidEmail(email) {
    const lower = email.toLowerCase();
    const atIdx = lower.lastIndexOf('@');
    if (atIdx < 2) return false;
    const local = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx + 1);
    if (!local || !domain || local.length < 2 || local.length > 64) return false;
    if (!domain.includes('.') || domain.length < 4) return false;
    if (SKIP_DOMAINS.has(domain)) return false;
    // Devlet ve kamu kurumu emailleri filtrele
    if (GOVT_RE.test(domain)) return false;
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
    // tr.search.yahoo.com: Türkçe Yahoo subdomain — Alman IP'den bölge kilidi olmadan Türkçe sonuç verir
    const baseUrl = location === 'turkey'
        ? 'https://tr.search.yahoo.com/search'
        : 'https://search.yahoo.com/search';
    for (const b of [1, 11, 21]) {
        try {
            const url = `${baseUrl}?p=${encodeURIComponent(query)}&b=${b}`;
            const resp = await axios.get(url, { headers: getHeaders(), timeout: 12000 });
            if (resp.data.length < 2000) break; // Engel sayfası
            const $ = cheerio.load(resp.data);
            let found = 0;
            for (const sel of ['.algo-sr', '.Sr', '.dd.algo', '.algo', '#web li', '[data-bk="algo"]']) {
                $(sel).each((_, el) => {
                    const a = $(el).find('h3 a, h2 a, a[href^="http"]').first();
                    const title = a.text().trim() || $(el).find('h3, h2').first().text().trim();
                    const snippet = $(el).find('.compText, .compTitle, p').text().trim() || '';
                    const link = a.attr('href') || '';
                    if (title && link.startsWith('http')) { items.push({ title, snippet, link }); found++; }
                });
                if (found > 0) break;
            }
            await sleep(800);
        } catch {}
    }
    console.log(`[Yahoo] "${query.substring(0, 50)}" → ${items.length} sonuç`);
    return items;
}

// DuckDuckGo Lite — kl (region) parametresi Alman IP'de timeout'a yol açıyor, kaldırıldı
async function searchDDG(query, location) {
    const items = [];
    try {
        const resp = await axios.get(
            `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
            {
                headers: {
                    ...getHeaders(),
                    'Referer': 'https://lite.duckduckgo.com/',
                },
                timeout: 8000,
                maxRedirects: 3,
            }
        );
        if (resp.data.length < 1000 || !resp.data.includes('result-link')) {
            console.log(`[DDG] Sonuç yok veya engel (${resp.data.length} byte)`);
            return items;
        }
        const $ = cheerio.load(resp.data);
        $('tr').each((_, row) => {
            const a = $(row).find('a.result-link');
            if (!a.length) return;
            const title = a.text().trim();
            const link = a.attr('href') || '';
            const snippet = $(row).nextAll('tr').first().find('.result-snippet').text().trim();
            if (title && link.startsWith('http')) items.push({ title, snippet, link });
        });
        console.log(`[DDG] "${query.substring(0, 50)}" → ${items.length} sonuç`);
    } catch (e) {
        console.log(`[DDG] Hata: ${e.message.substring(0, 60)}`);
    }
    return items;
}

async function searchBing(query, location) {
    const items = [];
    for (const first of [1, 11, 21, 31]) {
        try {
            // cc=TR ve setlang Alman IP'den gelince Bing boş döndürüyor; sadece mkt yeterli
            let url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&count=10`;
            if (location === 'turkey') url += `&mkt=tr-TR`;
            const resp = await axios.get(url, { headers: getHeaders(), timeout: 12000 });
            if ($('#captcha').length || resp.data.includes('CaptchaAnswer') || resp.data.length < 2000) break;
            const $ = cheerio.load(resp.data);
            $('.b_algo').each((_, el) => {
                const title = $(el).find('h2').text().trim();
                const snippet = $(el).find('.b_caption p, .b_algoSlug').text().trim();
                const link = $(el).find('h2 a').attr('href') || '';
                if (title && link.startsWith('http')) items.push({ title, snippet, link });
            });
            await sleep(800);
        } catch {}
    }
    console.log(`[Bing] "${query.substring(0, 50)}" → ${items.length} sonuç`);
    return items;
}

async function searchYandex(query, location) {
    const items = [];
    try {
        // lr parametresi Alman IP'den Türk bölgesi seçince engel alıyor; yandex.com.tr zaten TR
        const url = `https://yandex.com.tr/search/?text=${encodeURIComponent(query)}&numdoc=10`;
        const resp = await axios.get(url, {
            headers: { ...getHeaders(), 'Referer': 'https://yandex.com.tr/' },
            timeout: 10000,
        });
        if (resp.data.length < 2000) { console.log(`[Yandex] Engel/boş sayfa`); return items; }
        const $ = cheerio.load(resp.data);
        // Yandex HTML ve JSON-in-HTML çıktısını dene
        const selectors = ['.organic', '.serp-item', '[class*="organic"]', '[data-fast-name="organic"]'];
        let found = 0;
        for (const sel of selectors) {
            $(sel).filter((_, el) => !$(el).hasClass('serp-adv')).each((_, el) => {
                const titleEl = $(el).find('h2 a, .organic__title-text, .title__text, h2').first();
                const title = titleEl.text().trim();
                const link = $(el).find('a[href^="http"]').first().attr('href') || '';
                const snippet = $(el).find('.text-container, .organic__text, p').first().text().trim().substring(0, 300);
                if (title && link.startsWith('http')) { items.push({ title, snippet, link }); found++; }
            });
            if (found > 0) break;
        }
        console.log(`[Yandex] "${query.substring(0, 50)}" → ${items.length} sonuç`);
    } catch (e) {
        console.log(`[Yandex] Hata: ${e.message.substring(0, 60)}`);
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

// ─── MX Cache + Domain Email Guesser — Ana Motor ─────────────────────────────

const mxCache = new Map(); // domain → true/false, bir kez sorgula yeter

async function hasMxRecord(domain) {
    if (mxCache.has(domain)) return mxCache.get(domain);
    try {
        const v = await emailValidator.validate({
            email: `info@${domain}`,
            validateRegex: true,
            validateMx: true,
            validateTypo: false,
            validateDisposable: false,
            validateSMTP: false,
        });
        const result = !!(v.validators && v.validators.mx && v.validators.mx.valid);
        mxCache.set(domain, result);
        return result;
    } catch {
        mxCache.set(domain, false);
        return false;
    }
}

// Türkçe ve evrensel kurumsal email prefixleri
const TR_BIZ_PREFIXES = ['info', 'iletisim', 'bilgi', 'destek', 'satis', 'pazarlama', 'contact', 'ofis'];
const GLOBAL_PREFIXES = ['info', 'contact', 'hello', 'sales', 'support', 'marketing', 'team', 'office'];

// Bir metnin kişi adı olup olmadığını kontrol eder: "Ali Kaya", "Mehmet Yılmaz Demir"
function isPersonName(text) {
    if (!text || text.length < 5 || text.length > 45) return false;
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) return false;
    // Her kelime büyük harfle başlamalı, sadece harf içermeli (Türkçe dahil)
    return words.every(w => /^[A-ZÇĞİÖŞÜ]/.test(w) && w.length >= 2 && !/[\d@#%!]/.test(w));
}

// Şirket web sitesinin ekip/team sayfasından çalışan isimlerini çeker
async function scrapeTeamMembers(origin) {
    const names = new Set();
    const TEAM_PATHS = ['/ekip', '/team', '/kadromuz', '/yonetim', '/hakkimizda', '/about'];

    for (const path of TEAM_PATHS) {
        try {
            const resp = await axios.get(origin + path, { headers: getHeaders(), timeout: 6000, maxRedirects: 2 });
            const $ = cheerio.load(resp.data);

            // Ekip kartları / member container'larındaki başlıkları tara
            const containers = $('[class*="ekip"],[class*="team"],[class*="member"],[class*="person"],[class*="kadro"],[class*="yonetim"],[class*="staff"],[class*="card"]');
            containers.each((_, el) => {
                const heading = $(el).find('h2,h3,h4,h5,strong,.name,.isim').first().text().trim();
                if (isPersonName(heading)) names.add(heading);
            });

            // Yedek: sayfadaki tüm h3/h4 başlıklarına bak
            if (names.size === 0) {
                $('h3,h4').each((_, el) => {
                    const t = $(el).text().trim();
                    if (isPersonName(t)) names.add(t);
                });
            }

            if (names.size > 0) break; // Bulundu, diğer path'leri deneme
        } catch {}
        await sleep(250);
    }

    return [...names].slice(0, 10); // Max 10 kişi per şirket
}

async function getDomainEmailGuesses(origin, tag, seenEmails) {
    let domain;
    try { domain = new URL(origin).hostname.replace(/^www\./, ''); } catch { return []; }
    if (!domain || GOVT_RE.test(domain)) return [];

    // Tüm generic pattern'leri önceden rezerve et (race condition önleme)
    const isTurkish = /\.tr$/.test(domain);
    const prefixes = isTurkish ? TR_BIZ_PREFIXES : GLOBAL_PREFIXES;
    const genericPatterns = prefixes.map(p => `${p}@${domain}`);
    genericPatterns.forEach(e => seenEmails.add(e));

    const mxOk = await hasMxRecord(domain);
    if (!mxOk) return [];

    // 1. Generic kurumsal emailler (info@, iletisim@, ...)
    const results = genericPatterns.map(email => ({
        email,
        title: `[MX✅] ${domain}`,
        source: origin,
        snippet: `MX kaydı doğrulandı — kurumsal email tahmini.`,
        tag,
    }));

    // 2. Ekip sayfası → kişisel iş emailleri (sadece .tr domainler için)
    if (isTurkish) {
        try {
            const teamMembers = await scrapeTeamMembers(origin);
            for (const name of teamMembers) {
                const parts = name.split(/\s+/).filter(Boolean);
                if (parts.length < 2) continue;
                // Her kişi için top 3 pattern (ad.soyad, a.soyad, asoyad)
                const personal = generateEmailPatterns(parts[0], parts[parts.length - 1], domain).slice(0, 3);
                for (const email of personal) {
                    if (!seenEmails.has(email)) {
                        seenEmails.add(email);
                        results.push({
                            email,
                            title: `[Ekip👤] ${name} — ${domain}`,
                            source: `${origin}/ekip`,
                            snippet: `Şirket ekip sayfasından bulunan çalışan: ${name}`,
                            tag,
                        });
                    }
                }
            }
        } catch {}
    }

    return results;
}

// LinkedIn profili için pattern push (MX cache kullanır)
async function validateAndPush(patterns, displayTitle, link, tag, seenEmails, results) {
    try {
        const domain = patterns[0].split('@')[1];
        const mxOk = await hasMxRecord(domain);
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

    const originList = [...urlsToScrape];

    // ① Domain Email Guesser — MX cache ile tüm domainleri paralel kontrol et
    //    Her MX-valid domain için 8 standart pattern üret (info@, iletisim@, bilgi@ vb.)
    const guessResults = await Promise.all(
        originList.slice(0, 15).map(origin => getDomainEmailGuesses(origin, tag, seenEmails))
    );
    guessResults.flat().forEach(lead => results.push(lead));

    // ② Bonus: contact sayfası scraping — görünür emailler için (JS olmayan siteler)
    for (const origin of originList.slice(0, 4)) {
        try {
            const webEmails = await scrapeWebsiteForEmails(origin);
            const isTurkish = /\.tr$/.test(new URL(origin).hostname);
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
        const [yahooItems, ddgItems, bingItems, yandexItems] = await Promise.all([
            searchYahoo(query, location),
            searchDDG(query, location),
            searchBing(query, location),
            searchYandex(query, location),
        ]);
        const all = [...yahooItems, ...ddgItems, ...bingItems, ...yandexItems];
        console.log(`[Query] "${query.substring(0, 60)}" → Toplam ${all.length} sonuç (Y:${yahooItems.length} D:${ddgItems.length} B:${bingItems.length} Yn:${yandexItems.length})`);
        return await processSearchItems(all, location, tag, globalSeenEmails);
    } catch (e) {
        console.error(`Query error [${tag}]:`, e.message);
        return [];
    }
}

// ─── Sorgu Şablonları — B2B ve B2P Ayrı Strateji ─────────────────────────────
//
// B2B (kurumsal): Şirket web sitelerini bul → iletişim sayfalarını tara
//   → Kurumsal email adresleri (info@firma.com.tr vb.)
//
// B2P (bireysel): Kişisel email adreslerini doğrudan ara
//   → Gmail/Hotmail + iş unvanı + Türkiye → menajer, sporcu, danışman vb.

function buildQueries(tag, location, searchType) {
    const type = searchType || 'b2b';

    if (location === 'turkey') {
        if (type === 'b2p') {
            // Bireysel kişiler: kişisel email adresleri hedeflenir
            return [
                `"@gmail.com" "${tag}" türkiye`,
                `"@hotmail.com" "${tag}" türkiye`,
                `"${tag}" "@gmail.com" ankara OR izmir OR bursa OR antalya`,
                `"${tag}" "@gmail.com" türkiye -site:instagram.com -site:facebook.com`,
                `site:instagram.com "${tag}" "türkiye" "@gmail.com" OR "@hotmail.com"`,
                `site:tr.linkedin.com/in "${tag}"`,
            ];
        }
        // B2B: şirket web siteleri birincil kaynak
        // İlk 2: Yahoo-friendly (site: operatörü kullanılmaz)
        // Sonrakiler: Bing/DDG/Yandex site: operatörünü iyi işler
        return [
            `"${tag}" "iletişim@" türkiye`,
            `"${tag}" "info@" ".com.tr"`,
            `"${tag}" site:.tr`,
            `"${tag}" türkiye "e-posta" -site:instagram.com -site:facebook.com`,
            `site:tr.linkedin.com/in "${tag}"`,
            `"${tag}" "@" türkiye -site:instagram.com -site:facebook.com -site:twitter.com`,
        ];
    }

    // Global
    if (type === 'b2p') {
        return [
            `"@gmail.com" "${tag}"`,
            `"@outlook.com" "${tag}"`,
            `site:instagram.com "${tag}" "@gmail.com" OR "@outlook.com"`,
            `site:linkedin.com/in "${tag}"`,
            `"${tag}" "@gmail.com" -site:facebook.com`,
        ];
    }
    return [
        `"${tag}" site:.com -site:facebook.com -site:twitter.com`,
        `"${tag}" email contact -site:facebook.com`,
        `"${tag}" "info@" OR "contact@"`,
        `site:linkedin.com/in "${tag}"`,
        `"${tag}" "@" email company`,
    ];
}

// ─── Ana Fonksiyon — 3 Paralel Worker ────────────────────────────────────────

async function findLeadsForTags(tags, location, searchType, onProgress) {
    const allLeads = [];
    const globalSeenEmails = new Set();
    const queries = tags.flatMap(tag => buildQueries(tag, location, searchType).map(q => ({ tag, q })));
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
