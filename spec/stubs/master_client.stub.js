var MasterClient = require('../../master_client.js');
var redisClientStubs = require('./redis_client.stub.js');

module.exports = MasterClientStub;

function MasterClientStub(master_name, port, host, slaves, timeout, options) {
    port = 80;
    host = 'google.com';
    MasterClient.call(this, master_name, port, host, slaves, timeout, options); 
        
    this.on_info_cmd = function(){};
}
MasterClientStub.prototype.__proto__ = MasterClient.prototype;

var fail_count;
MasterClientStub.prototype.connect_to_redis_instance = function( port, host ) {
    this.port = port;
    this.host = host;
    if (fail_count) {
        fail_count--;
        this.use_failing_client();
    }
    else this.use_succeeding_client();
}

MasterClientStub.prototype.super_send_command = function(command, args, cb) {
    if ( typeof args[args.length-1] == 'function' ) cb = args[args.length-1];
    cb(false, 'OK');
}
MasterClientStub.prototype.use_failing_client = function(times_failing) {
    fail_count = times_failing;
    this.super_send_command = function(command, args, cb) {
        if ( typeof args[args.length-1] == 'function' ) cb = args[args.length-1];
        cb(true);
    }
}
MasterClientStub.prototype.use_succeeding_client = function() {
    this.super_send_command = function(command, args, cb) {
        if ( typeof args[args.length - 1] == 'function' ){
            cb = args[args.length - 1];
            console.log('command: ', command);
            console.log('cb: ', cb);
        }
        cb(false, 'OK');
    }
}
