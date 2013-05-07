require('should');
var cp = require('child_process');
var redis = require('redis');

var Monitor = require('../../monitor.js');
var sentinels;
init_cluster();

monitor = new Monitor({
    ports: [26379, 26380]
});

function kill_slave(master_name, index) {
    var slave_config = monitor.slaves[master_name][index];
    var slave_client = redis.createClient(slave_config.port, slave_config.ip);
}
function init_cluster() {
    sentinels = cp.spawn('../../scripts/init_sentinel_cluster.sh', [2]);
}

describe('Sentinel Monitor', function() {
    it('gets correct cluster state from sentinels', function(done) {
        monitor.once('sync_complete', function() {
            monitor.sentinel_clients.length.should.eql(2);
            (!!monitor.masters['master0'] && !!monitor.masters['master1']).should.be.true;
            monitor.slaves['master0'].length.should.eql(2);
            monitor.slaves['master1'].length.should.eql(1);
            done();
        });
        monitor.sync();
    })
    it('has subscription to pubsub', function(done) {
        this.timeout(10000);
        monitor.current_subscription.once('pmessage', function() {
            done();
        });
        kill_slave('master0', 0);
    });
});
describe('MasterClient', function() {

    var master_client;

    beforeEach(function(done) {
        if (monitor.synced) {
            master_client = monitor.get_client('master1');
            master_client.failover_timeout = 20000;
            done();
        }
        else monitor.once('sync_conplete', function() {
            master_client = monitor.get_client('master1');
            master_client.failover_timeout = 20000;
            done();
        });
    });

    describe('Normal operation', function() {
        it('correctly sends commands to the master instance', function(done) {
            master_client.hset(['x', '5', '5'], function(err, response) {
                (!!err).should.be.false;
                response.should.eql(1);
                done();
            });
        })
    });

    var executed_commands = 0;
    describe('In failsafe state', function() {
        before(function(done) {
            master_client = monitor.get_client('master1');
            master_client.on('+failsafe', done);
            master_client.enter_failsafe_state();
        });
        this.timeout(10000);
        it('Queues write commands', function() {
            master_client.hset(['x', '0', '0'], execute_command);
            master_client.hset(['x', '1', '1'], execute_command);
            master_client.hset(['x', '2', '2'], execute_command);

            function execute_command(error) {
                if (!error) executed_commands++;
            }
            (master_client.cq.queue.length >= 3).should.be.true;
        });
        it('Executes reads on slave instance', function(done) {
            master_client.failsafe_state.should.eql('w');
            master_client.ping(function(error, response) {
                (!!master_client.cq).should.be.true;
                response.toLowerCase().should.eql('pong');
                done();
            });
        });
    });
    describe('Returning to normal operation', function() {
        var new_master_config = monitor.masters['master1'];
        before(function(done) {
            master_client.on('-failsafe', done);
            master_client.exit_failsafe_state({host: 'localhost', port: '6380'});
        });
        it('has executed all non-expired commands in queue', function(done) {
            (master_client.failsafe_state == undefined).should.be.true;
            this.timeout(5000);
            setTimeout( function() {
                // THE FUCKING COMMAND CALLBACKS ARE NOT FIREING
                executed_commands.should.eql(3);
                done();
            }, 4000);
        });
        it('writes to new master', function(done) {
            master_client.hset(['x', '3', '3'], function(err, response) {
                (!!err).should.be.false;
                (!!response).should.be.true;
                done();
            });
            (master_client.cq == undefined).should.be.true;
        });
        it('reads from new master', function(done) {
            master_client.hget(['x', '0'], function(err, resp) {
                (!!err).should.be.false;
                done();
            });
        });
    });
});
