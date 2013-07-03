var silent_logger = {
    log: silent,
    info: silent,
    warn: silent,
    error: silent
}

function silent() {};

var mutant_logger = {
    setLogger: function(logger) {
                   this.__proto__ = logger;
                   this.logger = logger;
                   delete this.last_logger;
                 },
    getLogger: function() {
                   return this.logger;
               },
    // declare fallbacks.  Using functions right now, may be cleaner to use object.defineProperty...
    debug: function() {
               if (this.logger.debug) return this.logger.debug.apply(this.logger, arguments);
               else this.info.appy(this, arguments);
           },
    squelch: function() {
                 if (this.last_logger) return;
                 var last_logger = this.getLogger();
                 this.setLogger(silent_logger);
                 this.last_logger = last_logger;
             },
    unsquelch: function() {
                   if (this.last_logger) this.setLogger(this.last_logger);
               },
    forceInfo: function() {
                   if (this.last_logger) this.last_logger.info.apply(this.last_logger, arguments);
                   else this.info.apply(this, arguments);
               }
};

// Default logger is console
mutant_logger.setLogger(console);

module.exports = mutant_logger;
