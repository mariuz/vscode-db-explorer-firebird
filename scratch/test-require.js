try {
  require('../out/test/setup.js');
  console.log('Require succeeded!');
} catch (e) {
  console.error('Require failed:', e);
}
