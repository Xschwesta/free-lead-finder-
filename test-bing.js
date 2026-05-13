const axios = require('axios');
const cheerio = require('cheerio');

async function testBing() {
  const query = '"Marketing Manager" "iletişim" "@gmail.com"';
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'SRCHD=AF=NOFORM; SRCHHPGUSR=CW=1920&CH=1080; _EDGE_S=F=1; MUID=1' // Dummy cookie
      }
    });
    const $ = cheerio.load(res.data);
    let text = '';
    $('.b_algo').each((i, el) => {
      text += $(el).text() + ' ';
    });
    const emails = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
    console.log('Bing Found:', emails ? [...new Set(emails)] : []);
  } catch(e) {
    console.error(e.message);
  }
}
testBing();
