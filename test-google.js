const google = require('google-this');

async function test() {
  const options = {
    page: 0, 
    safe: false, // Safe Search
    parse_ads: false, // If set to true sponsored results will be parsed
    additional_params: {
      hl: 'tr'
    }
  };
  
  try {
    const response = await google.search('"Marketing Manager" "iletişim" "@gmail.com"', options);
    console.log(response.results);
  } catch (e) {
    console.error(e);
  }
}
test();
