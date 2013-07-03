require('should');
logger = require('../../logger.js');

describe('Logger', function() {
    it('debug should fall back to info if not available');
    it('squelch should stop calling logger functions');
    it('unsquelch should begin calling logger functions again');
    it('should default to console logging behavior');
    it('setLogger should set the logger behavior');
});
