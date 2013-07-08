require('should');
logger = require('../../logger.js');

describe('Logger', function() {
    before(function() {
        logger.setDefaultLogger();
    });
    after(function() {
        logger.silence();
    });
    it('should default to console logging behavior', function() {
        logger.logger.should.equal(console);
    });
    it('debug should fall back to info if not available', function() {
        var infocalled = 0;
        logger.setLogger({info: function(){infocalled++;}});
        logger.debug();
        infocalled.should.eql(1);
    });
    it('squelch should stop logger from calling logger functions', function() {
        logger.setDefaultLogger();
        logger.squelch();
        (logger.info == console.info).should.be.false;
    });
    it('unsquelch should begin calling logger functions again', function() {
        logger.unsquelch();
        (logger.info == console.info).should.be.true;
    });
});
