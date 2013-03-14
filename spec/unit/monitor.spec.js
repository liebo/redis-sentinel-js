describe('Monitor', function() {
    describe('#get_client()', function() {
        it('Should return a correctly configured MasterClient' );
        it('Should return the same client on repeated requests' );
    });
    describe('#sync()', function() {
        it('Should select a sentinel which responds to ping');
        it('Should store master client configurations');
        it('Should store slave configurations for each master');
        it('Should emit a "master_config_ready" event for each master_config');
        it('Should emit a "cluster_ready" event for each loaded slave cluster');
    });
    describe('Inheritance', function() {
        it('Should inherit correcly from EventEmitter');
    });
    describe('#subscribe_to_sentinel()', function() {
        it('Should set listeners to pubsub of the given sentinel');
        describe('current_subscription', function() {
        });
    });
});
