require('should');
redis_sentinel = require('../../index.js');
var MonitorStub = require('../stubs/monitor.stub.js');

describe('Monitor', function() {

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
                monitor.sentinel_client.ping = function(cb) {
                    cb(true);
                };
                done()
            });
            monitor.sync();
        });

        it('Should select the first sentinel that responds to a ping', function() {
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
                if (num_clusters == 2) done();
            }
        });
    });

    describe('#subscribe_to_sentinel()', function() {
        it('Should set listeners to pubsub of the given sentinel',function(){});
    });
});