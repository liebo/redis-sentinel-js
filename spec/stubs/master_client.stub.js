var MasterClient = require('../../master_client.js');
var redisClientStubs = require('./redis_client.stub.js');

module.exports = MasterClientStub;

function MasterClientStub(master_name, port, host, slaves, timeout) {
    port = 80;
    host = 'google.com';
    MasterClient.call(this, master_name, port, host, slaves, timeout); 
        
}
MasterClientStub.prototype.__proto__ = MasterClient.prototype;
/*
MasterClientStub.prototype.connect_to_redis_instance = function( port, host ) {

}
*/
MasterClientStub.prototype.super_send_command = function(command, args, cb) {
    if ( typeof args[-1] == 'function' ) cb = args[-1];
    cb(false, 'OK');
}
MasterClientStub.prototype._use_failing_client = function() {
    //redisClientStubs.FailingRedisClient.call(this);
    if ( typeof args[-1] == 'function' ) cb = args[-1];
    this.super_send_command = function(command, args, cb) {
        cb(true);
    }
}
MasterClientStub.prototype._use_succeeding_client = function() {
    //redisClientStubs.FailingRedisClient.call(this);
    if ( typeof args[-1] == 'function' ) cb = args[-1];
    this.super_send_command = function(command, args, cb) {
        cb(false, 'OK');
    }
}
