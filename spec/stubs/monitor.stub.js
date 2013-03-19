var Monitor = require('../../monitor.js');
var RedisClient = require('redis').RedisClient;
RedisClient.prototype.on_info_cmd = function(){};
RedisClient.prototype.ready_check = function(){};
var MasterClientStub = require('./master_client.stub.js');

var stub_master_response = [
    ['name', 'mymaster', 'ip', 'google.com', 'port', '80'],
    ['name', 'othermaster', 'ip', 'google.com', 'port', '80']
];

var stub_slave_responses = {
    mymaster: [
        ['ip', 'facebook.com', 'port', '80'],
        ['ip', 'twitter.com', 'port', '80']
    ],
    othermaster: [
    ]
};

var options = {
    host: 'google.com',
    ports: [80, 80, 80]
}

module.exports = MonitorStub;
function MonitorStub() {
    Monitor.call(this, options);
    this.sentinel_clients.forEach(function(sentinel) {
        stubOffSentinelClient(sentinel);
    });
    this.create_master_client = function(master_name, port, host, slaves, timeout) {
        return new MasterClientStub(master_name, port, host, slaves, timeout);
    }
}

MonitorStub.prototype = Monitor.prototype;

function stubOffSentinelClient(client) {
    client.send_command = function(command, args, cb) {
        if (args[0] == 'masters') cb(false, stub_master_response);
        else if (args[0] == 'slaves') cb(false, stub_slave_responses[args[1]]);
        else if (typeof args[0] !== 'function') throw 'Error in stubbed sentinel command';
    };
    client.ping = function(cb) {
        cb(false);
    };
}
