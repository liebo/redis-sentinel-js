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

var NegotiatorClient = require("./negotiator_client.js");
var Monitor = require("./monitor.js");

exports.Monitor = Monitor;
