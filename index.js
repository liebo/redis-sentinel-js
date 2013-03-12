/*

define = define || function () {};

define([], function () {
    return (module.exports = function () {
        //setup goes in here
        this.method = function () {
            console.log("o hai");
        }
    })();
});
    */
var Monitor = require("./monitor.js");

module.exports = function (options) {
    return new Monitor(options);
}


// exports.Monitor = Monitor;
