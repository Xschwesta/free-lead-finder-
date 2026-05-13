const emailValidator = require('deep-email-validator');

async function testEmail() {
  const email = 'contact@apple.com';
  console.log('Testing:', email);
  try {
    const res = await emailValidator.validate(email);
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(err);
  }
}

testEmail();
