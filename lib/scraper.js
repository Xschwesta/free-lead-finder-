const axios = require('axios');
const cheerio = require('cheerio');
const emailValidator = require('deep-email-validator');

const EMAIL_REGEX = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;

async function scrapeQuery(query) {
    const results = [];
    const seenEmails = new Set();
    try {
        // Sayfalama (Pagination): Her sorgu için ilk 3 sayfayı (0, 11, 21) tarayalım
        const pages = [1, 11, 21];
        for (const b of pages) {
            const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&b=${b}`;
            
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                },
                timeout: 10000 
            });

            const $ = cheerio.load(response.data);
            
            $('.algo-sr').each((i, element) => {
                const title = $(element).find('h3.title').text().trim() || $(element).find('.tz-title').text().trim();
                const snippet = $(element).find('.compTitle').next().text().trim() || $(element).find('.compText').text().trim() || $(element).text();
                const link = $(element).find('a').attr('href');
                
                const textToSearch = title + " " + snippet;
                
                // 1. Doğrudan e-posta arama
                const emails = textToSearch.match(EMAIL_REGEX);
                if (emails && emails.length > 0) {
                    emails.forEach(email => {
                        const cleanEmail = email.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
                        if (!seenEmails.has(cleanEmail) && cleanEmail.includes('@') && cleanEmail.length > 5 && !cleanEmail.includes('example.com') && !cleanEmail.includes('sentry.io')) {
                            seenEmails.add(cleanEmail);
                            results.push({ email: cleanEmail, title: title.replace(/\n/g, '').trim(), source: link || 'Yahoo Search', snippet: snippet.substring(0, 150) + "...", tag: "" });
                        }
                    });
                }

                // 2. LinkedIn Patern Tahmini (Pattern Guessing)
                if (query.includes('linkedin.com') && title.includes('-') && !title.includes('?')) {
                    const parts = title.split('-');
                    if (parts.length >= 2) {
                        const nameParts = parts[0].trim().toLowerCase().split(' ');
                        const companyPart = parts.length >= 3 ? parts[2].split('|')[0].trim().toLowerCase() : parts[1].split('|')[0].trim().toLowerCase();
                        
                        if (nameParts.length >= 2 && companyPart.length > 2 && !companyPart.includes('linkedin')) {
                            const firstName = nameParts[0].replace(/[^a-z]/g, '');
                            const lastName = nameParts[nameParts.length - 1].replace(/[^a-z]/g, '');
                            const domain = companyPart.replace(/[^a-z0-9]/g, '') + '.com';
                            
                            if (firstName && lastName && domain.length > 5) {
                                const guessedEmail = `${firstName}.${lastName}@${domain}`;
                                if (!seenEmails.has(guessedEmail)) {
                                    seenEmails.add(guessedEmail);
                                    
                                    // Sadece formatı listeye ekliyoruz, SMTP kontrolü çok zaman alır diye async bir worker'a bırakılabilir 
                                    // Ancak şimdilik listede "Doğrulanmamış" olarak gösterelim
                                    results.push({
                                        email: guessedEmail,
                                        title: `[Tahmin - VPS ile Doğrulanabilir] ${parts[0].trim()} @ ${companyPart}`,
                                        source: link || 'Pattern Guesser',
                                        snippet: "AI tarafından üretildi. VPS sunucusunda otomatik SMTP doğrulamasına girecek adres.",
                                        tag: ""
                                    });
                                }
                            }
                        }
                    }
                }
            });
            
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        return results;

    } catch (error) {
        console.error(`Arama hatası (${query}):`, error.message);
        return results; // hatalı olsa da bulduklarını dön
    }
}

async function findLeadsForTags(tags, onProgress) {
    let allLeads = [];
    let seenEmails = new Set();

    const queries = [];
    tags.forEach(tag => {
        // Her tag için sadece 2 farklı dork yapalım ki Yahoo'yu bloklamayalım.
        queries.push({ tag, q: `"${tag}" "iletişim" "@gmail.com"` });
        queries.push({ tag, q: `"${tag}" site:instagram.com "@gmail.com"` });
    });

    for (let i = 0; i < queries.length; i++) {
        const { tag, q } = queries[i];
        
        if (onProgress) {
            onProgress({ type: 'status', message: `Tarama (${i+1}/${queries.length}) [${tag}]: ${q}` });
        }

        const leads = await scrapeQuery(q);
        
        leads.forEach(lead => {
            if (!seenEmails.has(lead.email)) {
                seenEmails.add(lead.email);
                lead.tag = tag;
                allLeads.push(lead);
                if (onProgress) {
                    onProgress({ type: 'lead', data: lead });
                }
            }
        });

        // Engellenmemek için araya 3 Saniye delay koyuyoruz.
        if (i < queries.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    if (onProgress) {
        onProgress({ type: 'complete', count: allLeads.length });
    }

    return allLeads;
}

module.exports = {
    findLeadsForTags
};
