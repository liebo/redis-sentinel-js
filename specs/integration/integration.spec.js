require('should');
var cp = require('child_process');
var redis = require('redis');

var Monitor = require('../../monitor.js');
//var sentinels;
// Make sure you run init_sentinel_cluster in redis-sentinel/scrips with at least 2 sentinels
//init_cluster();

/*
monitor = new Monitor({
    hosts: [
        'localhost:26379',
        'localhost:26380']
});
*/

//console.log('the monitor settings are:', monitor.options);

function kill_slave(monitor, master_name, index) {
    var slave_config = monitor.slaves[master_name][index];
    var slave_client = redis.createClient(slave_config.port, slave_config.ip);
    slave_client.shutdown();
    slave_client.end();
}
function init_cluster(done) {
    var sentinels = cp.spawn( __dirname + '/../../scripts/init_sentinel_cluster.sh', ['2']);
    sentinels.stderr.setEncoding('utf8');
    sentinels.stderr.on('data', console.log.bind(console));
    sentinels.stdout.setEncoding('utf8');
    sentinels.stdout.once('data', function(){setTimeout(done, 1500)});
}

describe('Sentinel Monitor', function() {
    var sentinels;
    var monitor;
    beforeEach(function(done) {
        sentinels = init_cluster(function() {
            monitor = new Monitor({
                hosts: [
                    'localhost:26379',
                    'localhost:26380']
            });
            monitor.once('synced', done);
            monitor.sync();
        });
    });
    it('gets correct cluster state from sentinels', function() {
        monitor.sentinels.length.should.eql(2);
        (!!monitor.masters['master0'] && !!monitor.masters['master1']).should.be.true;
        monitor.slaves['master0'].length.should.eql(2);
        monitor.slaves['master1'].length.should.eql(1);
    })
    it('has subscription to pubsub', function(done) {
        this.timeout(10000);
        monitor.current_subscription.once('pmessage', function() {
            done();
        });
        // below is commented out b/c pubsub will dump all messages recieved before subscription
        //kill_slave(monitor, 'master0', 0);
    });
});
describe('MasterClient', function() {

    var master_client;
    var monitor;
    var sentinels;
    before(function(done) {
        sentinels = init_cluster(function() {
            monitor = new Monitor({
                hosts: [
                    'localhost:26379',
                    'localhost:26380']
            });
            monitor.once('synced', function() {
                master_client = monitor.get_client('master1');
                master_client.failover_timeout = 20000;
                done();
            });
            monitor.sync();
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
        var test1ran = false;
        var test2ran = false;
        var master_client;

        before(function(done) {
            master_client = monitor.get_client('master0');
            master_client.once('+failsafe', done);
            master_client.enter_failsafe_state();
        });
        after(function(done) {
            master_client.on('-failsafe', done);
            master_client.exit_failsafe_state({host: 'localhost', port: '6380'});
        });
        this.timeout(10000);
        it('Queues write commands', function() {
            master_client.hset(['x', '0', '0'], cb);
            master_client.hset(['x', '1', '1'], cb);
            master_client.hset(['x', '2', '2'], cb);

            master_client.cq.queue.length.should.eql(3);
            function cb(){executed_commands++};
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
        var master_client;
        before(function() {
            master_client = monitor.get_client('master0');
        });
        it('has executed all non-expired commands in queue', function(done) {
            (master_client.failsafe_state == undefined).should.be.true;
            this.timeout(5000);
                // THE FUCKING COMMAND CALLBACKS ARE NOT FIREING
                executed_commands.should.eql(3);
                done();
            //}, 4000);
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
