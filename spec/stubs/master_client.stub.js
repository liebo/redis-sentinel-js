var MasterClient = require('../../master_client.js');
var redisClientStubs = require('redis_client.sub.js');

function MasterClientStub(master_name, port, host, slaves, timeout) {
    port = 80;
    host = 'google.com';
    MasterClient.call(this, master_name, port, host, slaves, timeout); 
}
MasterClientStub.prototype.connect_to_redis_instance = function( port, host ) {

}
MasterClientStub.prototype._use_failing_client = function() {
    //redisClientStubs.FailingRedisClient.call(this);
    this.super_send_command = function(command, args, cb) {
        cb(true);
    }
}
MasterClientStub.prototype._use_succeeding_client = function() {
    //redisClientStubs.FailingRedisClient.call(this);
    this.super_send_command = function(command, args, cb) {
        cb(false, 'OK');
    }
}
