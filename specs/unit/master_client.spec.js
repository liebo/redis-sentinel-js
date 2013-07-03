require('should');
require('../../logger.js').squelch();
redis_sentinel = require('../../index.js');
var MonitorStub = require('../stubs/monitor.stub.js');

var monitor = new MonitorStub();

describe('MasterClient', function() {
    describe('On Initialization', function() {
        var master_client;
        beforeEach(function(done) {
            monitor.once('synced', function() {
                master_client = monitor.get_client('mymaster');
                done();
            });
            monitor.sync();
        });

        it('Should not be in failsafe mode', function() {
            (master_client.failover_state === undefined).should.be.true;
            (master_client.cq === undefined).should.be.true;
        });

        it('Should have a slave array which always references the corresponding slave array on the Monitor', function(done) {
            master_client.slaves.should.equal(monitor.slaves[master_client.name]);
            monitor.once('synced', function() {
                master_client.slaves.should.equal(monitor.slaves[master_client.name]);
                done();
            });
            monitor.sync();
        });
    });

    describe('#[redis command]', function() {
        var master_client;
        beforeEach(function(done) {
            if (!monitor.synced) monitor.once('synced', set_test_client);
            else set_test_client();
            function set_test_client() {
                master_client = monitor.get_client('mymaster');
                done();
            }
        });

        it('Should put cient in failsafe mode on failure', function(done) {
            master_client.use_failing_client();
            master_client.once('+failsafe', function() {done()});
            master_client.ping();
        });
    });
    describe('In failsafe state', function() {
        var monitor2 = new MonitorStub();
        monitor2.sync();
        var master_client;
        var slaveless_master;;
        beforeEach(function(done) {
            if (!monitor2.synced) monitor2.once('synced', set_test_clients);
            else set_test_clients();

            function set_test_clients() {
                master_client = monitor2.get_client('mymaster');
                slaveless_master = monitor2.get_client('othermaster');
                done();
            }
        });

        it('Should send all write commands to the Command Queue', function() {
            master_client.enter_failsafe_state();
            var orig_queue_len = master_client.cq.queue.length;
            var expected_queue_len = orig_queue_len + 2;
            master_client.set('x');
            master_client.del('x');
            master_client.cq.queue.length.should.eql(expected_queue_len);
        });
        it('Should be connected to a valid slave', function() {
            var connected_to_slave = (master_client.host == 'facebook.com' ||
            master_client.host == 'twitter.com');
            console.log(master_client.host, master_client.port);
            connected_to_slave.should.be.true;
        });
        it('Should send read commands to command queue if no slaves are available', function() {
            slaveless_master.use_failing_client();
            slaveless_master.ping();
            var orig_len = slaveless_master.cq.queue.length;
            slaveless_master.get('x');
            slaveless_master.cq.queue.length.should.equal(orig_len + 1);
        });
    });
    describe('Exiting failsafe state', function() {
        var master_client;
        beforeEach(function(done) {
            if (monitor.synced) set_test_client();
            else monitor.once('synced', set_test_client);
            function set_test_client() {
                master_client = monitor.get_client('mymaster');
                done();
            }
        });

        it('Should stop queuing commands', function(done) {
            master_client.once('-failsafe', function() {
                master_client.host.should.equal('google.com');
                (!master_client.cq).should.be.true;
                master_client.ping(function() {done()});
            });
            master_client.exit_failsafe_state({port:80, host:'google.com'});
            master_client.emit('connect'); // make sure this fires
        });
    });
});
