require('should');
var CommandQueue = require('../../command_queue.js');
var client_stub = {
    failover_timeout: 350,
    send_command: function(command, args, callback) {
        this.num_commands_executed = this.num_commands_executed || 0;
        this.num_commands_executed++;
    }
};
describe( 'CommandQueue', function() {
    it('expires old commands by calling the callback with an error', function(done) {
        this.timeout(1000);
        var cq = new CommandQueue(client_stub);
        var num_errors = 0;
        cq.ping(add_error);
        cq.ping(add_error);
        cq.ping(add_error);
        cq.queue.length.should.eql(3);
        setTimeout(function() {
            num_errors.should.eql(3);
            done();
        }, 700);
        function add_error(error, response) {
            if (error) num_errors++;
        }
    });
    it('executes commands when exec is called', function(done) {
        var cq = new CommandQueue(client_stub);
        cq.ping();
        cq.ping();
        cq.ping();
        cq.exec();
        (client_stub.num_commands_executed == 3 ).should.be.true;
        done();
    });
});
