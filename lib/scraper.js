const axios = require('axios');
const cheerio = require('cheerio');
const emailValidator = require('deep-email-validator');

const EMAIL_REGEX = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;

async function scrapeQuery(query, location) {
    const results = [];
    const seenEmails = new Set();
    const validationPromises = []; 
    try {
        const pages = [1, 11, 21, 31, 41, 51];
        for (const b of pages) {
            // Eğer Türkiye seçiliyse Yahoo'yu Türkçe sonuçlara (vl=lang_tr) zorluyoruz
            let url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&b=${b}`;
            if (location === 'turkey') {
                url += `&vl=lang_tr&vc=tr`; 
            }
            
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

                // 2. LinkedIn Patern Tahmini
                if (query.includes('linkedin.com') && title.includes('-') && !title.includes('?')) {
                    const parts = title.split('-');
                    if (parts.length >= 2) {
                        const nameParts = parts[0].trim().toLowerCase().split(' ');
                        const rawCompany = parts.length >= 3 ? parts[2].split('|')[0].trim().toLowerCase() : parts[1].split('|')[0].trim().toLowerCase();
                        
                        const trMap = {'ç':'c', 'ğ':'g', 'ı':'i', 'i':'i', 'ö':'o', 'ş':'s', 'ü':'u'};
                        const normalizeTr = (str) => str.replace(/[çğıiöşü]/g, m => trMap[m]);
                        
                        const cleanCompany = rawCompany.replace(/ltd|şti|a\.ş|aş|anonim|şirketi|kurumu|özel|hizmetleri|sanayi|ticaret|grup/g, '').trim();

                        if (nameParts.length >= 2 && cleanCompany.length > 2 && !cleanCompany.includes('linkedin')) {
                            const firstName = normalizeTr(nameParts[0]).replace(/[^a-z]/g, '');
                            const lastName = normalizeTr(nameParts[nameParts.length - 1]).replace(/[^a-z]/g, '');
                            const domain = normalizeTr(cleanCompany).replace(/[^a-z0-9]/g, '') + '.com';
                            
                            if (firstName && lastName && domain.length > 4) {
                                const guessedEmail = `${firstName}.${lastName}@${domain}`;
                                if (!seenEmails.has(guessedEmail)) {
                                    seenEmails.add(guessedEmail);
                                    
                                    const p = emailValidator.validate({
                                        email: guessedEmail,
                                        validateRegex: true,
                                        validateMx: true,
                                        validateTypo: false,
                                        validateDisposable: true,
                                        validateSMTP: false 
                                    }).then(validation => {
                                        if (validation.valid || (validation.validators.mx && validation.validators.mx.valid)) {
                                            results.push({
                                                email: guessedEmail,
                                                title: `[Doğrulandı ✅] ${parts[0].trim()} @ ${rawCompany}`,
                                                source: link || 'Pattern Guesser',
                                                snippet: "Domain (MX) kayıtları doğrulandı.",
                                                tag: "Doğrulanmış B2B"
                                            });
                                        }
                                    }).catch(() => {});
                                    
                                    validationPromises.push(p);
                                }
                            }
                        }
                    }
                }
            });
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        await Promise.all(validationPromises);
        return results;

    } catch (error) {
        console.error(`Arama hatası (${query}):`, error.message);
        return results; 
    }
}

async function findLeadsForTags(tags, location, onProgress) {
    let allLeads = [];
    let seenEmails = new Set();

    const queries = [];
    
    tags.forEach(tag => {
        if (location === 'turkey') {
            // Sadece Türkleri bulması için sorguları "Türkiye" ve Türkçe kelimelerle ZORUNLU kılıyoruz.
            queries.push({ tag, q: `"${tag}" ("Türkiye" OR "İstanbul") "iletişim" email` });
            queries.push({ tag, q: `"${tag}" site:tr.linkedin.com/in` });
            queries.push({ tag, q: `"${tag}" ("Türkiye" OR "İstanbul") site:instagram.com "@gmail.com"` });
        } else {
            queries.push({ tag, q: `"${tag}" "contact" email OR mail` });
            queries.push({ tag, q: `"${tag}" site:linkedin.com/in` });
            queries.push({ tag, q: `"${tag}" site:instagram.com "@gmail.com" OR "@yahoo.com"` });
        }
    });

    for (let i = 0; i < queries.length; i++) {
        const { tag, q } = queries[i];
        
        if (onProgress) {
            onProgress({ type: 'status', message: `Tarama (${i+1}/${queries.length}) [${tag}]: ${q}` });
        }

        const leads = await scrapeQuery(q, location);
        
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
