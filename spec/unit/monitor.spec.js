require('should');
redis_sentinel = require('../../index.js');
var MonitorStub = require('../stubs/monitor.stub.js');

describe('Monitor', function() {
    describe('#get_client()', function() {
        var monitor = new MonitorStub();
        monitor.sync();
        var master_client;

        it('Should return a correctly configured MasterClient', function(){ 
            master_client = monitor.get_client('mymaster');
            (master_client instanceof redis_sentinel.MasterClient).should.be.true;
        });
        it('Should return the same client on repeated requests', function() {
            var another_client = monitor.get_client('mymaster');
            master_client.should.equal(another_client);
        });
    });
    describe('#sync()', function() {
        var monitor = new MonitorStub();
        monitor.sentinel_clients[0].ping = function(cb) {
            cb(true);
        }
        monitor.sync();

        it('Should select the first sentinel that responds to a ping', function() {
            monitor.current_sentinel.should.equal(monitor.sentinel_clients[1]);
        });

        it('Should store master client configurations', function() {
            (typeof monitor.masters.mymaster).should.equal('object');
            monitor.masters.othermaster.ip.should.equal('google.com');
        });
        it('Should store slave configurations for each master', function() {
            (monitor.slaves.mymaster instanceof Array).should.be.true;
        });
        it('Should emit a "master_config_loaded" event for each master_config', function(done) {
            var num_master_configs = 0;
            monitor.on('master_config_loaded', increment_num_configs);
            monitor.sync();
            function increment_num_configs() {
                num_master_configs++;
                if (num_master_configs == 2) done();
            }
        });
        it('Should emit a "cluster_ready" event for each loaded slave cluster', function(done) {
            var num_clusters = 0;
            monitor.on('cluster_ready', increment_num_clusters);
            monitor.sync();
            function increment_num_clusters() {
                num_clusters++;
                if (num_clusters >= 2) done();
            }
        });
    });
    describe('#subscribe_to_sentinel()', function() {
        it('Should set listeners to pubsub of the given sentinel');
        describe('current_subscription', function() {
        });
    });
});
