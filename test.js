const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const q = encodeURIComponent('"e ticaret" "iletisim" "@gmail.com"');
  try {
    const res = await axios.get('https://search.yahoo.com/search?p=' + q, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    const $ = cheerio.load(res.data);
    let text = '';
    $('.algo').each((i, el) => { text += $(el).text() + ' '; });
    const emails = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
    console.log('Found:', emails ? [...new Set(emails)] : []);
  } catch(e) { console.error(e.message); }
}
test();
