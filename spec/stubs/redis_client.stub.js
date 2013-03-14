var redis = require('redis');
var net_client = require('net').createClient(80, 'google.com');

exports.FailingRedisClient = FailingRedisClient;
exports.SucceedingRedisClient = SucceedingRedisClient;


function FailingRedisClient() {
    // connect to google to prevent ConnectionRefused errors
    redis.RedisClient.call(this, net_client);
    this.send_command = function(command, args, cb) {
        cp(true);
    }
}

function SucceedingRedisClient() {
    // connect to google to prevent ConnectionRefused errors
    redis.RedisClient.call(this, net_client);
    this.send_command = function(command, args, cb) {
        cb(false, 'OK');
    }
}
