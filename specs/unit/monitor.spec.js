require('should');
var MonitorStub = require('../stubs/monitor.stub.js');
require('../../logger.js').silence();

describe('Monitor', function() {

    it('should emit all_down if it looses connection to sentinels', function(){});
    it('should select a new sentinel when the current sentienl client errors', function(){});

    describe('#get_client()', function() {
        var monitor;
        var master_client;

        beforeEach(function(done) {
            master_client;
            monitor = new MonitorStub();
            monitor.once('synced', function() {
                master_client = monitor.get_client('mymaster');
                done();
            });
            monitor.sync();
        });

        it('Should return the same client on repeated requests', function() {
            var another_client = monitor.get_client('mymaster');
            master_client.should.equal(another_client);
        });
    });

    describe('#sync()', function() {
        var monitor;

        beforeEach( function(done) {
            monitor = new MonitorStub();
            monitor.once('synced', function() {
                done()
            });
            monitor.sync();
        });

        it('Should select the first sentinel it can connect to', function() {
            monitor.sentinel_client.host.should.equal(monitor.sentinels[0].host);
            monitor.sentinel_client.port.should.equal(monitor.sentinels[0].port);
        });

        it('Should store master client configurations', function() {
            (typeof monitor.masters.mymaster).should.equal('object');
            monitor.masters.othermaster.ip.should.equal('google.com');
        });
        it('Should store slave configurations for each master', function() {
            monitor.slaves.mymaster.should.be.an.instanceOf(Array);
        });
        it('Should emit a "master_config_loaded" event for each master_config', function(done) {
            var simplemon = new MonitorStub();
            var num_master_configs = 0;
            simplemon.on('master_config_loaded', increment_num_configs);
            simplemon.sync();
            function increment_num_configs() {
                ++num_master_configs;
                if (num_master_configs == 2) done();
            }
        });
        it('Should emit a "cluster_ready" event for each loaded slave cluster', function(done) {
            var num_clusters = 0;
            var simplemon = new MonitorStub();
            simplemon.on('cluster_ready', increment_num_clusters);
            simplemon.sync();
            function increment_num_clusters() {
                num_clusters++;
                if (num_clusters == 2) done();
            }
        });
    });

    describe('Sentinel PubSub', function() {
        it('Should set listeners to pubsub of the given sentinel',function(){});

        describe('#on_obj_down', function(){
            var monitor;
            before(function(done) {
                monitor = new MonitorStub();
                monitor.once('synced', done);
                monitor.sync();
            });
            it('should remove slaves from the slaves array', function() {
                monitor.current_subscription.emit('pmessage', '*', '+odown', {data:'slave name facebook.com 80 @ mymaster'});
                monitor.slaves.mymaster.length.should.eql(1);
            });
            it('should cause masters to enter failover', function() {
                var master_client = monitor.get_client('mymaster');
                monitor.current_subscription.emit('pmessage', '*', '+odown', {data:'master mymaster google.com 80'});
                (!!master_client.failsafe_state).should.be.true;
            });
        });
        describe('#on_obj_up', function(){
            var monitor;
            beforeEach(function(done) {
                monitor = new MonitorStub();
                monitor.once('synced', done);
                monitor.sync();
            });
            it('should cause masters to exit failover', function(done) {
                var master_client = monitor.get_client('mymaster');
                master_client.enter_failsafe_state();
                master_client.on('-failsafe', done);
                monitor.current_subscription.emit('pmessage', '*', '-odown', {data:'master mymaster twitter.com 80'});
            });
            it('should add slaves to the slave array', function() {
                monitor.current_subscription.emit('pmessage', '*', '-odown', {data:'slave mymaster twitter5.com 80 @ mymaster'});
                monitor.slaves.mymaster.length.should.eql(3);
            });
            it('should not add slaves if they are already registered', function() {
                monitor.current_subscription.emit('pmessage', '*', '-odown', {data:'slave mymaster twitter.com 80 @ mymaster'});
                monitor.slaves.mymaster.length.should.eql(2);
            });
            it('should add sentinel configs to the sentinels array', function() {
                monitor.current_subscription.emit('pmessage', '*', '-odown', {data:'sentinel mymaster twitter.com 80'});
                monitor.sentinels.length.should.eql(4);
            });
            it('should not add sentinels if they are already registered', function() {
                monitor.current_subscription.emit('pmessage', '*', '-odown', {data:'sentinel mymaster google.com 80'});
                monitor.sentinels.length.should.eql(3);
            });
        });
        describe('#on_new_sentinel', function(){
            var monitor;
            before(function(done) {
                monitor = new MonitorStub();
                monitor.once('synced', done);
                monitor.sync();
            });
            it('should add the sentinel config to the list if it does not already exist', function() {
                monitor.current_subscription.emit('pmessage', '*', '+sentinel', {data:'sentinel mymaster twitter.com 80'});
                monitor.current_subscription.emit('pmessage', '*', '+sentinel', {data:'sentinel mymaster twitter.com 80'});
                monitor.sentinels.length.should.eql(4);
            });
        });
        describe('#on_new_slave', function(){
            it('should add the slave to the slaves array if it does not already exist', function() {
                //monitor.current_subscription.emit('pmessage', '*', '+slave', 'slave mymaster twitter.com 80 @ mymaster');
            });
        });
        describe('#on_switch_master', function(){
            it('should cause the corresponding master client to exit failsafe', function() {
            });
        });
        describe('#on_reboot_instance', function(){});
        
    });
});
